import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /block-names?q=`: what has been typed into the block slip's name so
 * far. Absent or blank lists the most recent names.
 */
export class ListBlockNamesQuery extends createZodDto(
  z.object({
    // A block's name is at most 60 characters, so a longer `q` matches none.
    q: z.string().trim().max(60).default(''),
  }),
) {}
