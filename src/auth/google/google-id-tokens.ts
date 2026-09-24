import type { IdTokens } from '../id-tokens/id-tokens';
import {
  fetchJwks,
  JwksVerifier,
  type FetchKeys,
} from '../id-tokens/jwks-verifier';

/**
 * Injection token for whatever checks Google ID tokens. A token rather than a
 * class, like `MAILER`, so tests swap in a fake without reaching Google.
 */
export const GOOGLE_ID_TOKENS = Symbol('GOOGLE_ID_TOKENS');

/** Where Google publishes the keys its ID tokens are signed with. */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google writes `iss` both ways (its OpenID Connect docs). */
export const GOOGLE_ISSUERS: [string, ...string[]] = [
  'accounts.google.com',
  'https://accounts.google.com',
];

/** Checks Google ID tokens issued to one of `clientIds`. */
export function googleIdTokens(
  clientIds: string[],
  fetchKeys: FetchKeys = fetchJwks(GOOGLE_JWKS_URL),
): IdTokens {
  return new JwksVerifier({
    issuers: GOOGLE_ISSUERS,
    audiences: clientIds,
    fetchKeys,
  });
}
