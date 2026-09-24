import type { AppleGrant } from './apple-grants.repository';

/**
 * Injection token for Apple's token endpoint. A token rather than a class,
 * like `MAILER`, so tests swap in a fake without reaching Apple.
 */
export const APPLE_TOKENS = Symbol('APPLE_TOKENS');

/**
 * What Apple made of an authorization code. `invalid` is the client's
 * problem (401): the code is used, expired or not ours. `unavailable` is
 * ours (503): Apple is unreachable, or refused our own credentials, which
 * `reason` says for the log.
 */
export type AppleCodeExchange =
  | { outcome: 'exchanged'; refreshToken: string }
  | { outcome: 'invalid' }
  | { outcome: 'unavailable'; reason: string };

export interface AppleTokens {
  /** Trades the code Sign in with Apple gave the app for a refresh token. */
  exchange(code: string, clientId: string): Promise<AppleCodeExchange>;
  /** Ends the account's Apple grant. Rejects when Apple doesn't confirm it. */
  revoke(grant: AppleGrant): Promise<void>;
}
