import { createZodValidationPipe } from 'nestjs-zod';

/**
 * The app-wide request validation pipe: every `@Body()`, `@Query()` and
 * `@Param()` is parsed against the zod schema carried by its declared DTO
 * before the handler runs.
 *
 * `strictSchemaDeclaration` makes an unvalidated parameter a loud 500 rather
 * than a silent pass-through, so the pipe fails closed.
 */
export const ZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
});
