import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * **This is not an idempotency key**, and the two must not be merged later on
 * the grounds that they look alike. Their handling is opposite in every respect
 * that matters.
 *
 * This id identifies one HTTP *attempt*: a retry carries a different value, an
 * absent one is minted, and a malformed one is ignored so that the request
 * still succeeds — a bad correlation id is not worth failing over.
 *
 * An idempotency key identifies one logical *operation*: a retry must carry the
 * same value, and an absent or malformed one has to fail the request. A key
 * that is silently ignored is worse than no key at all, because the caller
 * believes the write is protected against retrying twice.
 *
 * Idempotency belongs in the schema instead, as a unique `idempotency_key`
 * column on the table being written.
 */

/**
 * What we are willing to adopt from a caller. An inbound id is untrusted input
 * that ends up on every log line of the request and in a response header, so it
 * is bounded in length (it must not bloat every line it appears on) and in
 * charset (it must stay one readable token). Anything else is ignored rather
 * than rejected — a bad correlation id is not worth failing a request over.
 */
const INBOUND_ID = /^[A-Za-z0-9_-]{1,128}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Optional because a request can fail before any middleware runs — see
       * `ensureRequestId`. Anything reaching a handler has one.
       */
      requestId?: string;
    }
  }
}

/**
 * Returns the request's id, adopting or minting and then stamping one if it has
 * none.
 *
 * `pino-http`'s `genReqId` is the normal caller, which makes this the single
 * place an id is born — the same value becomes `req.id`, the `reqId` on every
 * log line of the request, and the `X-Request-Id` response header.
 *
 * It is not the only caller: Nest registers its body parser *ahead* of
 * `configure()` middleware, so a malformed JSON body throws before pino's
 * middleware has run. `AllExceptionsFilter` therefore calls this too, and no
 * response goes out untraceable.
 *
 * The id lives in the header and the logs, never in the response body: a header
 * is present on every response, including the ones with no body and the ones
 * whose body is not ours to shape.
 */
export function ensureRequestId(request: Request, response: Response): string {
  request.requestId ??= inboundId(request) ?? randomUUID();

  if (!response.headersSent) {
    response.setHeader(REQUEST_ID_HEADER, request.requestId);
  }

  return request.requestId;
}

/** The caller-supplied id, if there is one and it is safe to echo and log. */
function inboundId(request: Request): string | undefined {
  const header = request.headers['x-request-id'];

  // Express hands back an array when a header is repeated. A request carrying
  // two ids has no single id, so it gets a fresh one.
  if (typeof header !== 'string') return undefined;

  return INBOUND_ID.test(header) ? header : undefined;
}
