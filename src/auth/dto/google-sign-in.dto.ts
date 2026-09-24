import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class GoogleSignInBody extends createZodDto(
  z.strictObject({
    // Checked for shape only: three base64url segments, and far below the
    // cap, since Google's run to about 1.5 KB. Whether Google signed it is the
    // verifier's job, and a well-shaped bad token is a 401, not a 400.
    idToken: z
      .string()
      .max(8192)
      .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'Not an ID token.'),
  }),
) {}
