/**
 * Injection token for whatever checks Google ID tokens. A token rather than a
 * class, like `MAILER`, so tests swap in a fake without reaching Google.
 */
export const GOOGLE_ID_TOKENS = Symbol('GOOGLE_ID_TOKENS');

/** What a verified token proves, in the form Pebble stores it. */
export interface GoogleAccount {
  /** Trimmed and lower-cased (ACC-03). */
  email: string;
  /** Trimmed, at most 80 characters as `PATCH /me` allows; null if none. */
  name: string | null;
}

/**
 * The verdict on one token. Returned rather than thrown, so the caller maps
 * each case to its status: `invalid` is the client's problem (401),
 * `unavailable` is ours, since Google's keys could not be fetched (503).
 */
export type GoogleIdTokenCheck =
  | { outcome: 'verified'; account: GoogleAccount }
  | { outcome: 'invalid' }
  | { outcome: 'unavailable' };

export interface GoogleIdTokens {
  verify(idToken: string): Promise<GoogleIdTokenCheck>;
}
