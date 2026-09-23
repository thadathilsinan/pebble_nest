import { z } from 'zod';

/**
 * A refresh token as `newRefreshToken` issues it: 32 random bytes in
 * base64url, 43 characters. Checked for shape only; anything else is a
 * 400 before the database is asked.
 */
export const refreshToken = z
  .string()
  .regex(/^[\w-]{43}$/, 'Not a refresh token.');
