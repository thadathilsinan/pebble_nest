import type { Request, Response } from 'express';
import type { Options } from 'pino-http';
import type { Env } from '../config/env.schema';
import { HEALTH_ROUTES } from '../health/health.controller';
import { ensureRequestId } from '../http/request-id';

/**
 * Probe URLs as they appear on the wire — leading slash, no API prefix, since
 * `configure-app.ts` excludes them from it.
 */
const HEALTH_URLS = new Set(HEALTH_ROUTES.map((route) => `/${route}`));

/**
 * At or above this, the failure is ours. Mirrors `all-exceptions.filter.ts`,
 * which applies the same split to the line that says *why* a request failed.
 */
const SERVER_ERROR_FLOOR = 500;
const CLIENT_ERROR_FLOOR = 400;

/**
 * What `pino-http`'s own request serializer produces, narrowed to the keys we
 * keep. Declared structurally so nothing here depends on `pino-std-serializers`,
 * which is a transitive dependency rather than one we chose.
 */
interface SerializedRequest {
  id: unknown;
  method: string;
  url: string;
  remoteAddress?: string;
}

interface SerializedResponse {
  statusCode: number;
}

/** The completion line's fields, before we drop pino-http's synthetic error. */
interface CompletionLog {
  err?: unknown;
  [key: string]: unknown;
}

/**
 * Builds the `pino-http` configuration.
 *
 * Kept out of `logging.module.ts` so the module stays a wiring file and every
 * judgement call about what gets written lives in one place.
 */
export function pinoHttpOptions(env: Env): Options {
  return {
    level: env.LOG_LEVEL,

    // Every id is born in `ensureRequestId`, which also sets the response
    // header, so `req.id`, the `reqId` on each log line and `X-Request-Id` are
    // guaranteed to be the same value. The cast is a downcast: express's
    // Request and Response extend the node types pino-http declares.
    genReqId: (req, res) => ensureRequestId(req as Request, res as Response),

    // Binds a flat `reqId` onto the per-request logger instead of a whole
    // nested `req` object. Without this every application log line repeats the
    // full serialized request; with it, that detail appears once, on the
    // completion line.
    quietReqLogger: true,

    // Health probes are polled every few seconds forever, and a completion line
    // each time is the fastest way to make a log aggregator useless: the signal
    // is buried under traffic that says nothing except "the orchestrator is
    // still running".
    //
    // Only the automatic line is suppressed. Anything logged deliberately
    // still comes through — `HealthController` writes its own error line when a
    // readiness check fails, so these routes are silent while healthy and loud
    // when not, which is the right way round.
    autoLogging: {
      // `split` always yields at least one element, so the `?? ''` is appeasing
      // `noUncheckedIndexedAccess` rather than covering a real case — and it is
      // written as a fallback to the empty string precisely so that if that ever
      // stops being true, the probe match fails closed and the line is logged.
      ignore: (req) => HEALTH_URLS.has((req.url ?? '').split('?')[0] ?? ''),
    },

    // An allowlist, not a redact list. The default serializers emit all request
    // and response headers, which is how `authorization` and `set-cookie` end
    // up in a log aggregator in plaintext. A redact list would work, but it has
    // to name every secret-bearing header forever and fails open on the next
    // one someone adds; this fails closed — a new header is invisible until
    // somebody asks for it here.
    serializers: {
      req: (req: SerializedRequest) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      }),
      res: (res: SerializedResponse) => ({ statusCode: res.statusCode }),
    },

    // The same split `AllExceptionsFilter` uses: a client sending bad input is
    // routine and should not read as an incident. pino-http's default puts 4xx
    // at `warn`, which would make one policy disagree with itself.
    customLogLevel: (_req, res, error) =>
      error || res.statusCode >= SERVER_ERROR_FLOOR
        ? 'error'
        : res.statusCode >= CLIENT_ERROR_FLOOR
          ? 'debug'
          : 'info',

    // The filter has already logged the real cause against this same `reqId`.
    // Left alone, pino-http synthesises `new Error('failed with status code
    // 500')` for any 5xx it did not catch itself, whose stack points into
    // pino-http rather than at anything that went wrong.
    customErrorObject: (_req, _res, _error, val: CompletionLog) => {
      const line = { ...val };
      delete line.err;

      return line;
    },

    // Human-readable output is a development affordance and nothing else: the
    // transport runs pino-pretty in a worker thread, which is cost a production
    // process should not pay and a dependency it does not install. `test` is
    // deliberately excluded too — a worker thread outliving a jest run is a
    // well-known way to hang the suite.
    transport:
      env.NODE_ENV === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  };
}
