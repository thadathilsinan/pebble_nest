/**
 * Injection token for whatever delivers sign-in codes. A token rather than a
 * class, so tests and the eventual email provider swap in without the service
 * knowing which one it holds.
 */
export const MAILER = Symbol('MAILER');

export interface Mailer {
  /** Delivers `code` to `email`. Rejects if the message was not accepted. */
  sendSignInCode(email: string, code: string): Promise<void>;
}
