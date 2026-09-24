import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CHOSEN_TRACES } from '../../core/database/schema';
import { normaliseBlockName } from '../block-name';

/**
 * `PUT /block-names/{name}/trace`'s path. The name arrives normalised, and
 * needn't belong to a block yet: the slip rerolls before the block is saved.
 */
export class BlockNameParams extends createZodDto(
  z.object({
    name: z
      .string()
      .transform(normaliseBlockName)
      .pipe(z.string().min(1).max(60)),
  }),
) {}

/** `PUT /block-names/{name}/trace`. `open` is never a choice. */
export class SetTraceBody extends createZodDto(
  z.strictObject({ trace: z.enum(CHOSEN_TRACES) }),
) {}
