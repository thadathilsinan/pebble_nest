import { Injectable, type ArgumentMetadata } from '@nestjs/common';
import { createZodValidationPipe } from 'nestjs-zod';

/**
 * `strictSchemaDeclaration` makes an unvalidated parameter a loud 500 rather
 * than a silent pass-through, so the pipe fails closed.
 */
const StrictZodValidationPipe = createZodValidationPipe({
  strictSchemaDeclaration: true,
});

/**
 * The app-wide request validation pipe: every `@Body()`, `@Query()` and
 * `@Param()` is parsed against the zod schema carried by its declared DTO
 * before the handler runs.
 *
 * Custom parameter decorators such as `@CurrentCaller()` are passed through
 * untouched. Their values come from the server (the guard, here), not from the
 * client, so there is no input to validate. Without this exemption the strict
 * mode would turn every such parameter into a 500.
 */
@Injectable()
export class ZodValidationPipe extends StrictZodValidationPipe {
  override transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type === 'custom') return value;
    return super.transform(value, metadata);
  }
}
