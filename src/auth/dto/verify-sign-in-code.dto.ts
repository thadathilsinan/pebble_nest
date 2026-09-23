import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { emailAddress } from './email';

export class VerifySignInCodeBody extends createZodDto(
  z.strictObject({
    email: emailAddress,
    // A malformed code is a 400 VALIDATION_FAILED and does not spend an
    // attempt — only a well-formed wrong code does.
    code: z.string().regex(/^\d{6}$/, 'The code is six digits.'),
  }),
) {}
