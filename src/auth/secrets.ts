import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * The random values sign-in hands out and the one-way forms they are stored
 * in. Plain functions: nothing here has state or dependencies.
 */

/** Six digits, leading zeros kept (ACC-02). From the CSPRNG, never `Math.random`. */
export function generateSignInCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The stored form of a sign-in code.
 *
 * Keyed, because a code has only a million values and an unkeyed hash of one
 * is reversed by hashing them all. The email is part of the input so a hash
 * means nothing against any other row.
 */
export function hashSignInCode(
  secret: string,
  email: string,
  code: string,
): string {
  return createHmac('sha256', secret).update(`${email}\n${code}`).digest('hex');
}

/** Constant-time, so response timing says nothing about how close a guess was. */
export function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');

  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * A new refresh token and the hash it is stored under.
 *
 * 256 random bits, so an unkeyed SHA-256 is enough: there is nothing to
 * enumerate, unlike a six-digit code.
 */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');

  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
