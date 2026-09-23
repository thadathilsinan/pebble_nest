import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Caller, CallerRequest } from './caller';

/**
 * The `Caller` the guard proved. Throws on a `@Public()` route, where there is
 * none: reading a caller there is a mistake in the handler, not in the request.
 */
export const CurrentCaller = createParamDecorator(
  (_: unknown, context: ExecutionContext): Caller => {
    const { caller } = context.switchToHttp().getRequest<CallerRequest>();
    if (caller === undefined) {
      throw new Error('@CurrentCaller() used on a route the guard skipped');
    }
    return caller;
  },
);
