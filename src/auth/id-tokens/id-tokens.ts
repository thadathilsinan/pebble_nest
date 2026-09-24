/** What a verified ID token proves, in the form Pebble stores it. */
export interface IdTokenAccount {
  /** Trimmed and lower-cased (ACC-03). */
  email: string;
  /** Trimmed, at most 80 characters as `PATCH /me` allows; null if none. */
  name: string | null;
}

/**
 * The verdict on one token. Returned rather than thrown, so the caller maps
 * each case to its status: `invalid` is the client's problem (401),
 * `unavailable` is ours, since the provider's keys could not be fetched (503).
 */
export type IdTokenCheck =
  | { outcome: 'verified'; account: IdTokenAccount }
  | { outcome: 'invalid' }
  | { outcome: 'unavailable' };

/** Checks one provider's ID tokens: Google's, or Apple's identity tokens. */
export interface IdTokens {
  verify(idToken: string): Promise<IdTokenCheck>;
}
