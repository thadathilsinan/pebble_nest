import { createPublicKey, type JsonWebKey, type KeyObject } from 'node:crypto';
import { decode, verify, type JwtPayload } from 'jsonwebtoken';
import { emailAddress } from '../dto/email';
import type {
  GoogleAccount,
  GoogleIdTokenCheck,
  GoogleIdTokens,
} from './google-id-tokens';

/** Where Google publishes the keys its ID tokens are signed with. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google writes `iss` both ways (its OpenID Connect docs). */
const GOOGLE_ISSUERS: [string, ...string[]] = [
  'accounts.google.com',
  'https://accounts.google.com',
];

/** `PATCH /me`'s limit, so a Google name is one the user could have typed. */
const MAX_NAME_LENGTH = 80;

/**
 * The shortest time between two fetches of the key set. A token naming a key
 * the cache lacks refetches, since Google may have rotated one in, but no
 * sooner than this: `kid` is chosen by whoever sent the token, so without the
 * floor anyone could make every request cost a call to Google.
 */
const MIN_REFETCH_MS = 5 * 60 * 1000;

/** Used when Google's response carries no `max-age`. */
const DEFAULT_MAX_AGE_SECONDS = 60 * 60;

/** A key set and how long Google says it may be kept. */
export interface GoogleKeySet {
  keys: JsonWebKey[];
  maxAgeSeconds: number;
}

/** Fetches Google's key set. Rejects when it can't. */
export type FetchGoogleKeys = () => Promise<GoogleKeySet>;

interface CachedKeys {
  byKid: Map<string, KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Checks Google ID tokens against Google's published keys: an RS256
 * signature by a current key, Google's issuer, one of our client IDs as the
 * audience, an unexpired token, and a verified email.
 *
 * The key set is cached for as long as Google's `Cache-Control` says, and
 * concurrent requests share one fetch. When a fetch fails, a key already
 * cached is still used, since a key Google published minutes ago is still
 * Google's; only a token no cached key can check is `unavailable`.
 */
export class GoogleJwksVerifier implements GoogleIdTokens {
  private cache: CachedKeys | null = null;
  private fetching: Promise<CachedKeys> | null = null;

  constructor(
    private readonly clientIds: string[],
    private readonly fetchKeys: FetchGoogleKeys = fetchGoogleKeys,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(idToken: string): Promise<GoogleIdTokenCheck> {
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
        issuer: GOOGLE_ISSUERS,
        audience: this.clientIds as [string, ...string[]],
      }) as JwtPayload;
    } catch {
      return { outcome: 'invalid' };
    }

    const account = accountFrom(claims);

    return account === null
      ? { outcome: 'invalid' }
      : { outcome: 'verified', account };
  }

  /**
   * The cached key for `kid`, refetching the set when it has expired, or when
   * it lacks `kid` and was fetched long enough ago. `null` for a key Google
   * doesn't have. Rejects only when a fetch fails and no cached key fits.
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
    this.fetching ??= this.fetchKeys()
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

/** Google's live key set. The three-second limit keeps sign-in from hanging. */
export async function fetchGoogleKeys(): Promise<GoogleKeySet> {
  const res = await fetch(GOOGLE_JWKS_URL, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Google's keys answered ${res.status}`);

  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("Google's keys had no keys");

  return {
    keys: body.keys as JsonWebKey[],
    maxAgeSeconds: maxAgeOf(res.headers.get('cache-control')),
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
 * none, one Google hasn't verified, or one sign-in wouldn't accept.
 * `email_verified` is a boolean today; the string form is from Google's older
 * tokens.
 */
function accountFrom(claims: JwtPayload): GoogleAccount | null {
  const verified: unknown = claims.email_verified;
  if (verified !== true && verified !== 'true') return null;

  const email = emailAddress.safeParse(claims.email);
  if (!email.success) return null;

  return { email: email.data, name: nameFrom(claims.name) };
}

/** Trimmed and cut to 80 characters, never through a surrogate pair. */
function nameFrom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let name = raw.trim();
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
    name = name.trimEnd();
  }

  return name === '' ? null : name;
}
