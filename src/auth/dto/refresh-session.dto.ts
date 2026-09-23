import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { refreshToken } from './refresh-token';

export class RefreshSessionBody extends createZodDto(
  z.strictObject({ refreshToken }),
) {}
