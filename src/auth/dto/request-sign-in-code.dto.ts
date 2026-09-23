import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { emailAddress } from './email';

export class RequestSignInCodeBody extends createZodDto(
  z.strictObject({ email: emailAddress }),
) {}
