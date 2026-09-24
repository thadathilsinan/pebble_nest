import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { decode, verify, type JwtPayload } from 'jsonwebtoken';
import { emailAddress } from '../dto/email';
import type { IdTokenAccount, IdTokenCheck, IdTokens } from './id-tokens';
import { providerName } from './provider-name';

/**
 * The shortest time between two fetches of the key set. A token naming a key
 * the cache lacks refetches, since the provider may have rotated one in, but
 * no sooner than this: `kid` is chosen by whoever sent the token, so without
 * the floor anyone could make every request cost a call to the provider.
 */
const MIN_REFETCH_MS = 5 * 60 * 1000;

/** Used when the provider's response carries no `max-age`. */
const DEFAULT_MAX_AGE_SECONDS = 60 * 60;

/** A key set and how long the provider says it may be kept. */
export interface KeySet {
  keys: JsonWebKey[];
  maxAgeSeconds: number;
}

/** Fetches a provider's key set. Rejects when it can't. */
export type FetchKeys = () => Promise<KeySet>;

/** Whose tokens a verifier accepts. */
export interface JwksVerifierOptions {
  /** Every accepted spelling of the provider's `iss`. */
  issuers: [string, ...string[]];
  /** Our client IDs: a token for any other audience is someone else's. */
  audiences: string[];
  fetchKeys: FetchKeys;
}

interface CachedKeys {
  byKid: Map<string, KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Checks OpenID Connect ID tokens against a provider's published keys: an
 * RS256 signature by a current key, the provider's issuer, one of our client
 * IDs as the audience, an unexpired token, and a verified email. Google's and
 * Apple's tokens both fit this shape.
 *
 * The key set is cached for as long as the provider's `Cache-Control` says,
 * and concurrent requests share one fetch. When a fetch fails, a key already
 * cached is still used, since a key published minutes ago is still the
 * provider's; only a token no cached key can check is `unavailable`.
 */
export class JwksVerifier implements IdTokens {
  private cache: CachedKeys | null = null;
  private fetching: Promise<CachedKeys> | null = null;

  constructor(
    private readonly options: JwksVerifierOptions,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(idToken: string): Promise<IdTokenCheck> {
    const header = decode(idToken, { complete: true })?.header;

    // RS256 is checked again by `verify`; refusing others here keeps an HS256
    // token from ever being checked against a public key as if it were a
    // secret, the classic JWT forgery.
    if (header?.alg !== 'RS256' || header.kid === undefined) {
      return { outcome: 'invalid' };
    }

    let key: KeyObject | null;
    try {
      key = await this.keyFor(header.kid);
    } catch {
      return { outcome: 'unavailable' };
    }
    if (key === null) return { outcome: 'invalid' };

    let claims: JwtPayload;
    try {
      claims = verify(idToken, key, {
        algorithms: ['RS256'],
        issuer: this.options.issuers,
        audience: this.options.audiences as [string, ...string[]],
      }) as JwtPayload;
    } catch {
      return { outcome: 'invalid' };
    }

    const account = accountFrom(claims);
    if (account === null) return { outcome: 'invalid' };

    // `verify` has checked that at least one audience is ours.
    const audiences = [claims.aud].flat();
    const audience = this.options.audiences.find((id) =>
      audiences.includes(id),
    );
    if (audience === undefined) return { outcome: 'invalid' };

    return { outcome: 'verified', account, audience };
  }

  /**
   * The cached key for `kid`, refetching the set when it has expired, or when
   * it lacks `kid` and was fetched long enough ago. `null` for a key the
   * provider doesn't have. Rejects only when a fetch fails and no cached key
   * fits.
   */
  private async keyFor(kid: string): Promise<KeyObject | null> {
    const now = this.now();
    const cached = this.cache;
    const known = cached?.byKid.get(kid) ?? null;

    const fresh = cached !== null && now < cached.expiresAt;
    if (fresh && known !== null) return known;
    if (fresh && now - cached.fetchedAt < MIN_REFETCH_MS) return null;

    try {
      return (await this.refresh()).byKid.get(kid) ?? null;
    } catch (error) {
      if (known !== null) return known;
      throw error;
    }
  }

  private refresh(): Promise<CachedKeys> {
    this.fetching ??= this.options
      .fetchKeys()
      .then(({ keys, maxAgeSeconds }) => {
        const fetchedAt = this.now();
        this.cache = {
          byKid: publicKeysByKid(keys),
          fetchedAt,
          expiresAt: fetchedAt + maxAgeSeconds * 1000,
        };
        return this.cache;
      })
      .finally(() => {
        this.fetching = null;
      });

    return this.fetching;
  }
}

/**
 * Fetches the key set published at `url`. The three-second limit keeps
 * sign-in from hanging.
 */
export function fetchJwks(url: string): FetchKeys {
  return async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);

    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error(`${url} had no keys`);

    return {
      keys: body.keys as JsonWebKey[],
      maxAgeSeconds: maxAgeOf(res.headers.get('cache-control')),
    };
  };
}

export function maxAgeOf(cacheControl: string | null): number {
  const match = /(?:^|[\s,])max-age=(\d+)/i.exec(cacheControl ?? '');

  return match === null ? DEFAULT_MAX_AGE_SECONDS : Number(match[1]);
}

/** The RSA keys in `keys` by `kid`. A key Node can't read is left out. */
function publicKeysByKid(keys: JsonWebKey[]): Map<string, KeyObject> {
  const byKid = new Map<string, KeyObject>();

  for (const jwk of keys) {
    if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
    try {
      byKid.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // Skipped: a malformed key can't have signed a token we'd accept.
    }
  }

  return byKid;
}

/**
 * The account a verified token names, or `null` when it proves no email:
 * none, one the provider hasn't verified, or one sign-in wouldn't accept.
 * `email_verified` is a boolean in Google's tokens today; the string form is
 * from Google's older tokens, and Apple sends either.
 */
function accountFrom(claims: JwtPayload): IdTokenAccount | null {
  const verified: unknown = claims.email_verified;
  if (verified !== true && verified !== 'true') return null;

  const email = emailAddress.safeParse(claims.email);
  if (!email.success) return null;

  return { email: email.data, name: providerName(claims.name) };
}
