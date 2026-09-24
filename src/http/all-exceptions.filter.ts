import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import {
  describeDriverError,
  type DriverContext,
} from '../database/driver-error';
import type { ApiError, ApiFailure, ErrorDetail, MetaScalar } from './envelope';
import { codeForStatus, type ErrorCode } from './error-code';
import { ensureRequestId } from './request-id';

/**
 * What a 5xx says out loud. The real cause is logged against the request id and
 * never written to the response: an exception message is written for us, not for
 * whoever is holding the other end of the socket.
 */
const OPAQUE_MESSAGE = 'An unexpected error occurred.';

/**
 * What a timeout says. Deliberately identical to the `TIMED_OUT` message in
 * `src/database/driver-error.ts`, because the two reach a caller as the same
 * status for the same reason — one limit fired on a statement, the other on the
 * whole request — and a client should not have to tell them apart.
 */
const TIMED_OUT_MESSAGE =
  'The request took too long to complete and was cancelled.';

/**
 * At or above this, the failure is ours rather than the caller's. Widened to
 * `number` on purpose: a status read off an exception is a plain number, not an
 * `HttpStatus` member.
 */
const SERVER_ERROR_FLOOR: number = HttpStatus.INTERNAL_SERVER_ERROR;

/**
 * Renders every throwable as one `ApiFailure`, so a client never has to parse a
 * second error shape.
 *
 * Registered as an `APP_FILTER`, which also puts it behind Nest's not-found
 * handler and its Express error layer — so unmatched routes, malformed JSON and
 * anything thrown from middleware come through here too.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  // `PinoLogger` is transient, so setting the context here affects this
  // instance only. It reads the request's logger out of async-local storage on
  // every call, which is what puts `reqId` on these lines for free.
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const requestId = ensureRequestId(request, response);
    const outcome = describe(exception);
    const { status, error } = outcome;

    this.log(exception, request, outcome, requestId);

    // Nothing to render once the status line is on the wire — a failure partway
    // through a stream can only be cut short.
    if (response.headersSent) {
      response.end();
      return;
    }

    // `requestId` is deliberately absent from the body: it goes out as a header
    // and into the log line above, which covers every response — including the
    // ones whose body is not ours to shape.
    response.status(status).json({ error } satisfies ApiFailure);
  }

  private log(
    exception: unknown,
    request: Request,
    { status, error, context }: Outcome,
    requestId: string,
  ): void {
    // Method and URL are deliberately absent: pino-http's completion line
    // already carries them under the same `reqId`, and this line is here to say
    // what only it knows — which code the throwable mapped to, and why.
    //
    // `context` is where a database failure becomes debuggable. A constraint
    // violation is a 4xx, so it is logged at `debug` with no stack — and the
    // constraint name is then the only thing that says *which* rule broke,
    // since the response deliberately carries none of it.
    const fields = {
      ...correlation(request, requestId),
      statusCode: status,
      code: error.code,
      ...context,
    };

    // 4xx is the client's mistake and routine; only 5xx is ours, and only that
    // is worth a stack trace.
    if (status >= SERVER_ERROR_FLOOR) {
      this.logger.error(
        { ...fields, err: asError(exception) },
        'request failed',
      );
    } else {
      this.logger.debug(fields, 'request rejected');
    }
  }
}

/**
 * The request id, but only when pino has not already bound it.
 *
 * Inside the request context every line carries `reqId` from the child logger,
 * and repeating it here would emit the key twice in one JSON object. Outside it
 * — a body-parser failure, which throws before any middleware runs — this is
 * the only place the id can come from, and that is exactly the case
 * `ensureRequestId` exists for.
 */
function correlation(request: Request, requestId: string): { reqId?: string } {
  return request.id === undefined ? { reqId: requestId } : {};
}

/**
 * Pino's error serializer wants an `Error`. Throwing a non-`Error` is
 * pathological, but it should still produce a line with the usual shape rather
 * than whatever `{ err: 'some string' }` happens to serialize to.
 */
function asError(exception: unknown): Error {
  return exception instanceof Error ? exception : new Error(String(exception));
}

/**
 * What one throwable becomes: the status and body a client sees, plus anything
 * that belongs only in the log.
 */
interface Outcome {
  status: number;
  error: ApiError;
  /**
   * Extra log fields. Never merged into `error` — that is the whole point of
   * having somewhere else to put them.
   */
  context?: DriverContext;
}

function describe(exception: unknown): Outcome {
  if (exception instanceof ZodValidationException) {
    return {
      status: HttpStatus.BAD_REQUEST,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: toDetails(exception.getZodError()),
      },
    };
  }

  // `RequestTimeoutInterceptor` giving up. Ahead of the `HttpException` branch
  // because it is not one — rxjs throws its own error type — and ahead of the
  // driver branch only for readability, the two being disjoint.
  //
  // **This takes the same stated departure as a driver 5xx: the message is real
  // rather than opaque.** The rule exists because a message written at a throw
  // site describes our internals; this one is a constant in this file, derived
  // from nothing, and it carries the single useful thing a 504 body can — that
  // retrying may work. It is also the same sentence `driver-error.ts` returns for
  // SQLSTATE `57014`, which is a statement timeout: the same status for the same
  // reason should not answer differently depending on which limit fired.
  if (isTimeoutError(exception)) {
    return {
      status: HttpStatus.GATEWAY_TIMEOUT,
      error: { code: 'GATEWAY_TIMEOUT', message: TIMED_OUT_MESSAGE },
    };
  }

  // Thrown by the body parser, and by any middleware built on `http-errors`.
  // These carry a perfectly good status that Nest does not translate — see
  // `isHttpError` below — so without this branch an oversized body renders as
  // a 500 and pages someone for what is a client mistake.
  if (isHttpError(exception)) {
    const { status } = exception;

    return {
      status,
      error: {
        code: codeForStatus(status),
        // `expose` is http-errors' own answer to whether a message may be
        // shown. It is already false for every 5xx the library creates, so it
        // agrees with the rule the `HttpException` branch applies; checking it
        // as well only ever makes this more conservative, and it honours a 4xx
        // that some library deliberately marked private.
        message:
          exception.expose && status < SERVER_ERROR_FLOOR
            ? exception.message
            : OPAQUE_MESSAGE,
      },
    };
  }

  // Ahead of the `HttpException` branch, and that order is deliberate rather
  // than incidental: a handler that catches a driver error and throws its own
  // `ConflictException` has *already* decided what the caller sees, and its
  // exception never reaches here as a driver error at all. This branch is the
  // floor for everything nobody caught; `src/database/driver-error.ts` holds
  // the SQLSTATE table it consults.
  //
  // The driver's `message` is discarded here rather than sanitised. It names
  // the table and constraint, and `detail` quotes the offending value back —
  // which on a unique index over an email address turns a signup form into an
  // account-enumeration tool.
  //
  // **One departure, stated rather than buried: a driver 5xx keeps its message
  // instead of being replaced with `OPAQUE_MESSAGE`.** The rule below exists
  // because a message written at a throw site describes our internals even when
  // a developer meant well. These four do not — they are constants in
  // `driver-error.ts`, derived from nothing, and reviewed as a set. And the
  // distinction they carry is the most useful thing a 5xx body can hold: "try
  // again shortly" versus "this will not get better", which is precisely what
  // `An unexpected error occurred.` refuses to say. Note the visible
  // consequence: `HealthController`'s 503 renders the opaque message while a
  // driver 503 renders a real one, because that one arrives as an
  // `HttpException` and takes the branch below.
  const driverFailure = describeDriverError(exception);

  if (driverFailure !== undefined) {
    const { status, code, message, context } = driverFailure;

    return { status, error: { code, message }, context };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // Like the message, `meta` is for the caller only on a 4xx: a 5xx says
    // nothing about our internals, however it was thrown.
    const code = namedCode(exception.getResponse()) ?? codeForStatus(status);
    const meta =
      status < SERVER_ERROR_FLOOR
        ? namedMeta(exception.getResponse(), code)
        : undefined;

    return {
      status,
      error: {
        code,
        // A 5xx message describes our internals even when a developer wrote it.
        message:
          status >= SERVER_ERROR_FLOOR ? OPAQUE_MESSAGE : exception.message,
        ...(meta === undefined ? {} : { meta }),
      },
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: { code: 'INTERNAL_ERROR', message: OPAQUE_MESSAGE },
  };
}

/**
 * Whether a throwable is rxjs's `TimeoutError`, as thrown by the `timeout`
 * operator in `timeout.interceptor.ts`.
 *
 * Structural rather than `instanceof TimeoutError`, for the reason `isDriverError`
 * gives about `DatabaseError`: `instanceof` compares against one class object in
 * memory, and rxjs is both a direct dependency of this service and a peer of
 * `@nestjs/core`. Two copies in `node_modules` — which npm produces whenever
 * versions conflict — and the check silently fails, sending every timeout back to
 * being a 500.
 *
 * `name` is an own property rxjs assigns (`this.name = 'TimeoutError'`), and
 * `info` is the operator's own field; the pair is a fingerprint rather than a
 * coincidence, since `name` alone is a string anyone can set.
 */
function isTimeoutError(exception: unknown): boolean {
  return (
    exception instanceof Error &&
    exception.name === 'TimeoutError' &&
    'info' in exception
  );
}

/**
 * The shape `http-errors` gives its instances — the library express, body-parser
 * and much of the middleware ecosystem throw through.
 *
 * Declared structurally rather than imported: `http-errors` is a transitive
 * dependency of express rather than one this service chose, which is the same
 * call `src/logging/pino-options.ts` makes about `pino-std-serializers`.
 */
interface HttpErrorLike {
  status: number;
  statusCode: number;
  expose: boolean;
  message: string;
}

/**
 * Whether a throwable is one of those.
 *
 * Deliberately narrower than Nest's own `BaseExceptionFilter.isHttpError`,
 * which asks only for `statusCode` and `message`. Half the error objects in npm
 * carry a `statusCode` — an HTTP client's, a cloud SDK's — and matching one of
 * those would render its message straight to a caller, which is the single
 * thing this filter exists to prevent. Requiring `expose` as well, and requiring
 * the two status fields to agree, is a fingerprint of the library rather than a
 * coincidence of field names.
 *
 * Note the fields are inherited from `HttpError.prototype`, not own properties,
 * so any check written against `Object.keys` would quietly never match.
 */
function isHttpError(exception: unknown): exception is HttpErrorLike {
  if (!(exception instanceof Error)) return false;

  const { status, statusCode, expose } = exception as Partial<HttpErrorLike>;

  return (
    typeof statusCode === 'number' &&
    statusCode === status &&
    typeof expose === 'boolean'
  );
}

/**
 * Reads the code an exception named for itself. `HttpException` passes an object
 * response through untouched, so `new ConflictException({ code, message })` is
 * the whole mechanism — no exception subclass required.
 *
 * The cast is the trust boundary: a code is only real once it is in the
 * `ErrorCode` union, and `satisfies ErrorCode` at the throw site is what checks
 * that.
 */
function namedCode(body: unknown): ErrorCode | undefined {
  if (typeof body !== 'object' || body === null) return undefined;

  const { code } = body as { code?: unknown };

  return typeof code === 'string' ? (code as ErrorCode) : undefined;
}

/**
 * Reads the `meta` an exception carries for its caller, as in
 * `new BadRequestException({ code, message, meta: { attemptsLeft: 2 } })`.
 *
 * Only a `meta` key is read, and only scalar values survive it. Everything
 * else on the response object is dropped — which is the point: a field reaches
 * the client because someone put it under `meta` for them, never because it
 * happened to be on the object.
 *
 * One object gets through: `current` on `STALE_VERSION`, the resource as it now
 * stands (`docs/adding-a-feature.md` §6.3). It is allowed for that code and key
 * only, so an object put under `meta` anywhere else is still dropped. It is
 * rendered as given, so the throw site must pass the mapped response type,
 * never a row.
 */
function namedMeta(body: unknown, code: ErrorCode): ApiError['meta'] {
  if (typeof body !== 'object' || body === null) return undefined;

  const { meta } = body as { meta?: unknown };
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return undefined;
  }

  const entries = Object.entries(meta as Record<string, unknown>).filter(
    (entry): entry is [string, MetaScalar | object] => {
      const [key, value] = entry;

      if (key === 'current' && code === 'STALE_VERSION') {
        return (
          typeof value === 'object' && value !== null && !Array.isArray(value)
        );
      }

      return (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      );
    },
  );

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

interface ZodIssueLike {
  path: PropertyKey[];
  code: string;
  message: string;
}

/**
 * Flattens zod's issues into our own shape. Deliberately not zod's raw `issues`
 * array: those keys vary by issue type and are zod internals, not a contract we
 * can hold still across a zod upgrade.
 */
function toDetails(zodError: unknown): ErrorDetail[] | undefined {
  if (typeof zodError !== 'object' || zodError === null) return undefined;

  const { issues } = zodError as { issues?: unknown };
  if (!Array.isArray(issues)) return undefined;

  return (issues as ZodIssueLike[]).map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
