import type { IdTokens } from '../id-tokens/id-tokens';
import {
  fetchJwks,
  JwksVerifier,
  type FetchKeys,
} from '../id-tokens/jwks-verifier';

/**
 * Injection token for whatever checks Apple identity tokens. A token rather
 * than a class, like `GOOGLE_ID_TOKENS`, so tests swap in a fake.
 */
export const APPLE_ID_TOKENS = Symbol('APPLE_ID_TOKENS');

/** Where Apple publishes the keys its identity tokens are signed with. */
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

export const APPLE_ISSUER = 'https://appleid.apple.com';

/**
 * Checks Apple identity tokens issued to one of `clientIds`. They carry no
 * name: Apple gives the app the person's name once, on the first sign-in,
 * and the app sends it in the request body.
 */
export function appleIdTokens(
  clientIds: string[],
  fetchKeys: FetchKeys = fetchJwks(APPLE_JWKS_URL),
): IdTokens {
  return new JwksVerifier({
    issuers: [APPLE_ISSUER],
    audiences: clientIds,
    fetchKeys,
  });
}
