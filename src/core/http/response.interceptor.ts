import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { ApiSuccess } from './envelope';

const NO_ENVELOPE = 'http:no-envelope';

/**
 * Opts a handler (or a whole controller) out of the envelope, so its return
 * value is the response body verbatim.
 *
 * Needed wherever the body is not ours to shape: a file or stream, an
 * `@Redirect()` (whose `{ url, statusCode }` Nest reads itself), or a payload
 * whose format an external consumer already fixed.
 */
export const NoEnvelope = (): CustomDecorator => SetMetadata(NO_ENVELOPE, true);

/**
 * Wraps every handler's return value as `{ data }`, so a client parses one
 * shape whatever the endpoint. Opt a handler out with `@NoEnvelope()`.
 *
 * It never touches the request, which is what keeps a success response
 * byte-identical for identical data — and its `ETag` therefore stable.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const optedOut = this.reflector.getAllAndOverride<boolean>(NO_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (optedOut) return next.handle();

    return next.handle().pipe(
      map((payload: unknown) =>
        // A handler that returns nothing means an empty body; wrapping it would
        // invent one. `null` is a real value and does get wrapped.
        payload === undefined
          ? payload
          : ({ data: payload } satisfies ApiSuccess<unknown>),
      ),
    );
  }
}
