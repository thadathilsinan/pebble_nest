import type { PinoLogger } from 'nestjs-pino';
import type { Pool, PoolClient } from 'pg';
import type { Logger } from 'pino';

/**
 * Times every statement this service sends and writes a line for it, carrying
 * the request id of whoever caused it.
 *
 * **The wrap point is `client.query`, not `pool.query`, and that is the whole
 * subtlety of this file.** `pg-pool`'s `query()` checks out a client and
 * delegates to `client.query`, so wrapping the client catches both. Wrapping the
 * pool instead would catch only the standalone case: code inside a transaction
 * has already checked out a client and calls `client.query` directly, so every
 * statement between `begin` and `commit` would be invisible — which is exactly
 * the work most worth being able to see.
 *
 * Hooking the `connect` event rather than the pool's own method means each
 * physical connection is wrapped once, as it is opened, for its whole life.
 *
 * There is a second half to that, and it is not visible from the outside:
 * `pg-pool` delegates using `client.query`'s **callback** form, so handling only
 * the promise form catches nothing that went through `pool.query`. See
 * `wrapClient`.
 */

/** Longest query text written to a log line, in characters. */
const MAX_SQL_LENGTH = 300;

/**
 * What these lines call themselves. Written onto the line by hand rather than
 * through `PinoLogger.setContext`, because these lines are not written through
 * `PinoLogger` at all — see `wrapClient` on why the bound logger is captured.
 */
const LOG_CONTEXT = 'DatabaseQuery';

/**
 * `client.query` is heavily overloaded — text, text plus values, a config
 * object, a `Submittable` — and this wrapper deliberately understands almost
 * none of that. It reads two things and passes everything through untouched,
 * so a form it has never seen still behaves exactly as it did unwrapped.
 */
type QueryFn = (...args: unknown[]) => unknown;

/** What a line says about one statement. Parameters are never among it. */
interface QueryLine {
  sql: string;
  params: number;
  durationMs: number;
  ok: boolean;
}

/**
 * Installs the wrapper. Called once, from the pool factory.
 *
 * `logger` is a `PinoLogger` rather than a raw pino instance on purpose: its
 * `logger` getter reads the request-scoped child out of the `AsyncLocalStorage`
 * that `nestjs-pino` already opens per request, falling back to the root logger
 * outside one. That reuses the async context `nestjs-pino` already maintains
 * rather than opening a second one, and is what puts `reqId` on a query line
 * for free — *provided* the getter is read at the right moment, which
 * `wrapClient` explains.
 */
export function installQueryLogging(
  pool: Pool,
  logger: PinoLogger,
  slowQueryMs: number,
): void {
  pool.on('connect', (client) => wrapClient(client, logger, slowQueryMs));
}

function wrapClient(
  client: PoolClient,
  logger: PinoLogger,
  slowQueryMs: number,
): void {
  // Cast because the overloads cannot be expressed as one signature; `bind`
  // first so the original keeps its receiver once the property is replaced.
  const target = client as unknown as { query: QueryFn };
  const original = target.query.bind(client);

  target.query = (...args: unknown[]): unknown => {
    // **Captured here, synchronously, and that is the whole point.**
    //
    // `PinoLogger.logger` reads the request-bound child out of the
    // `AsyncLocalStorage` that `nestjs-pino` opens per request. This line runs
    // inside the caller's context, so it gets the right one. Reading it later —
    // when the query settles — does not: a query callback fires from `pg`'s
    // socket handling, whose async context belongs to whoever last caused that
    // socket to do something, not to whoever asked this question.
    //
    // That is not theoretical. Logging at settle time, a readiness probe's
    // `SELECT 1` was recorded under the *previous* request's `reqId` — the
    // worst possible failure for a correlation id, because the line looks
    // perfectly well-formed and attributes work to the wrong request.
    const bound = logger.logger;
    const startedAt = performance.now();

    const settle = (ok: boolean): void => {
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;

      write(bound, slowQueryMs, { ...describeQuery(args), durationMs, ok });
    };

    const last = args[args.length - 1];

    // **The callback form is the one that matters most**, which is the
    // opposite of what it looks like from application code.
    //
    // Nothing in this service calls `client.query(text, values, cb)` — but
    // `pg-pool`'s own `query()` does, internally, on the client it checked out.
    // So every `pool.query(...)` in the codebase arrives here as a callback
    // call. Passing this form through untimed, which read as a reasonable way
    // to avoid half-supporting an unused API, silently made the standalone
    // query invisible and left only queries issued directly on a checked-out
    // client being logged. Found by running it, not by reading it.
    if (typeof last === 'function') {
      const callback = last as (...values: unknown[]) => unknown;

      const timed = (...values: unknown[]): unknown => {
        // node-style: a null or undefined first argument means success.
        settle(values[0] === null || values[0] === undefined);

        return callback(...values);
      };

      return original(...args.slice(0, -1), timed);
    }

    const result = original(...args);

    // A `Submittable` — a cursor or a stream — comes back as a `Query` object
    // that completes through events rather than either of the two forms above.
    // Passed through untimed, and unlike the callback case that really is
    // nothing: `pg` itself never routes an ordinary query this way.
    if (!isThenable(result)) return result;

    // `then` with two handlers rather than `finally`, so a rejection is
    // recorded as one and then rethrown unchanged. The error itself is not
    // logged here — `AllExceptionsFilter` already logs it against the same
    // `reqId`, with the constraint name this line does not have.
    return result.then(
      (value) => {
        settle(true);

        return value;
      },
      (error: unknown) => {
        settle(false);

        throw error;
      },
    );
  };
}

/**
 * Writes the line.
 *
 * A slow query is a `warn` because it is the shape of an incident starting: the
 * pool saturates, `DB_ACQUIRE_TIMEOUT_MS` begins firing, and readiness starts
 * shedding traffic — all downstream of statements that got slower first.
 * Everything else is `debug`, which means it is silent at the production floor
 * of `info` and available locally by setting `LOG_LEVEL=debug`.
 *
 * That does make readiness chatty in development, since `/health/ready` polls
 * `SELECT 1` every few seconds. `src/core/logging/pino-options.ts` resolves the same
 * tension the other way for the HTTP completion line, and the difference is
 * deliberate: a probe's own latency is the first visible symptom of a pool
 * running out of connections, so it is the one probe signal worth keeping.
 */
function write(logger: Logger, slowQueryMs: number, line: QueryLine): void {
  // `context` is set by hand because this writes through the raw pino child
  // rather than through `PinoLogger`, which is what adds the key normally.
  const fields = { context: LOG_CONTEXT, ...line };

  if (line.durationMs >= slowQueryMs) {
    logger.warn(fields, 'slow query');

    return;
  }

  logger.debug(fields, 'query');
}

/**
 * The query text and how many parameters it carried.
 *
 * **Parameter values are never read, let alone logged** — only counted. They
 * are the request's data: an email address, a password reset token, whatever
 * the caller sent. This is the same rule the header allowlist in
 * `src/core/logging/pino-options.ts` applies, for the same reason.
 *
 * The text itself is developer-written and safe to log, which holds only while
 * values arrive as parameters. A query built by concatenating a value into the
 * string would put that value here — and would be an SQL injection before it
 * was a logging problem.
 */
function describeQuery(args: unknown[]): { sql: string; params: number } {
  const [first, second] = args;

  const text =
    typeof first === 'string'
      ? first
      : (readText(first) ?? '[unrecognised query form]');

  const values = Array.isArray(second) ? second : readValues(first);

  return { sql: truncate(text), params: values?.length ?? 0 };
}

function readText(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined;

  const { text } = config as { text?: unknown };

  return typeof text === 'string' ? text : undefined;
}

function readValues(config: unknown): unknown[] | undefined {
  if (typeof config !== 'object' || config === null) return undefined;

  const { values } = config as { values?: unknown };

  return Array.isArray(values) ? values : undefined;
}

/**
 * One line, bounded. Multi-line SQL would otherwise turn one log entry into
 * twenty in any viewer that splits on newlines, and a generated `IN (...)` list
 * can run to kilobytes.
 */
function truncate(sql: string): string {
  const flattened = sql.replace(/\s+/g, ' ').trim();

  return flattened.length <= MAX_SQL_LENGTH
    ? flattened
    : `${flattened.slice(0, MAX_SQL_LENGTH)}…`;
}

function isThenable(value: unknown): value is Promise<unknown> {
  if (typeof value !== 'object' || value === null) return false;

  return typeof (value as { then?: unknown }).then === 'function';
}
