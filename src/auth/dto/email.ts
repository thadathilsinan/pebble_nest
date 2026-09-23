import { z } from 'zod';

/**
 * An email address as sign-in stores it: trimmed and lower-cased before it is
 * checked, so `Me@Example.com ` and `me@example.com` are one account (ACC-03)
 * and `ck_users_email_lowercase` never sees a mixed-case value.
 */
export const emailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));
