import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One part of the name, as Sign in with Apple hands it to the app. */
const namePart = z.string().max(200).nullish();

export class AppleSignInBody extends createZodDto(
  z.strictObject({
    // Checked for shape only, as with Google's: whether Apple signed it is the
    // verifier's job, and a well-shaped bad token is a 401, not a 400.
    identityToken: z
      .string()
      .max(8192)
      .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/, 'Not an identity token.'),
    // Opaque to us; Apple's are well under 100 characters.
    authorizationCode: z.string().min(1).max(1024),
    // Sent by Apple on the account's first sign-in only, so the app passes it
    // on whenever it has it.
    fullName: z
      .strictObject({ givenName: namePart, familyName: namePart })
      .nullish(),
  }),
) {}
