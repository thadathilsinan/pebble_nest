import { HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '../http/error-code';

/**
 * Translates a database driver failure into the terms the HTTP layer speaks.
 *
 * This lives in `src/core/database/` rather than next to the filter that calls it
 * because a table of SQLSTATE codes is knowledge about Postgres, not about
 * HTTP. It imports one *type* from the http folder and nothing at runtime, so
 * the dependency is erased at compile time and there is no cycle.
 *
 * What it exists to prevent: without it, every constraint violation falls
 * through `AllExceptionsFilter`'s last branch and renders as a 500. That is
 * wrong twice over. The caller is told the server broke when the server worked
 * exactly as designed, and is implicitly told to retry something that will fail
 * identically forever. And `src/core/logging/pino-options.ts` logs 5xx at `error`
 * with a stack trace, so a duplicate signup becomes an error-level line — which
 * is how real incidents end up buried under routine user mistakes.
 */

/**
 * A driver failure rendered for a client: the status, the stable code, and a
 * message written for whoever is holding the other end of the socket.
 */
interface Rejection {
  status: number;
  code: ErrorCode;
  message: string;
}

/**
 * A rejection plus the fields that belong in the log and nowhere else.
 */
export interface DriverFailure extends Rejection {
  context: DriverContext;
}

/**
 * What gets logged about a driver failure.
 *
 * **`detail` is deliberately absent.** Postgres puts the offending values in it
 * — `Key (email)=(a@b.com) already exists.` — so logging it would write user
 * data into every aggregator this service ships to, which is the same thing the
 * header allowlist in `src/core/logging/pino-options.ts` exists to stop. The
 * constraint name says which rule broke, and that is the question a log is being
 * read to answer; the values are in the request the caller sent.
 */
export interface DriverContext {
  sqlstate?: string;
  table?: string;
  constraint?: string;
  column?: string;
  /** For failures that never reached the server, so carry no SQLSTATE. */
  driverCode?: string;
}

/**
 * The four rejections every mapped SQLSTATE lands on.
 *
 * Messages are fixed strings and never the driver's own. `error.message` reads
 * `duplicate key value violates unique constraint "uq_users_email"`, which
 * publishes the schema to anyone willing to submit a form twice. A constraint
 * name is an interface for *application* code, not for clients.
 */
const CONFLICT: Rejection = {
  status: HttpStatus.CONFLICT,
  code: 'CONFLICT',
  message: 'The request conflicts with the current state of the data.',
};

const UNPROCESSABLE: Rejection = {
  status: HttpStatus.UNPROCESSABLE_ENTITY,
  code: 'UNPROCESSABLE_ENTITY',
  message: 'The request breaks a rule the data must satisfy.',
};

const UNAVAILABLE: Rejection = {
  status: HttpStatus.SERVICE_UNAVAILABLE,
  code: 'SERVICE_UNAVAILABLE',
  message: 'The service is temporarily unavailable. Try again shortly.',
};

const TIMED_OUT: Rejection = {
  status: HttpStatus.GATEWAY_TIMEOUT,
  code: 'GATEWAY_TIMEOUT',
  message: 'The request took too long to complete and was cancelled.',
};

/**
 * unique_violation. Named because two places need it: the table below, and
 * `uniqueViolation` — the seam a handler uses to tell one duplicate from another.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE is the SQL standard's five-character identifier for *what* went
 * wrong — stable across server versions, and independent of the message text,
 * which is not (see `foreign key` below). Its first two characters are the
 * class: `23` integrity constraints, `40` transaction rollbacks, `08`
 * connection failures, `57` operator intervention.
 *
 * Anything absent from this table is left unmapped on purpose. An unrecognised
 * driver error is a 500, which is the honest answer: nothing here has decided
 * that it is the caller's fault.
 */
const REJECTION_BY_SQLSTATE: Record<string, Rejection> = {
  /** unique_violation — the row already exists. */
  [UNIQUE_VIOLATION]: CONFLICT,

  /**
   * exclusion_violation — an `EXCLUDE` constraint, which is how "these two
   * rows may not overlap" is stated in the database rather than in application
   * code.
   */
  '23P01': CONFLICT,

  /**
   * foreign_key_violation, and **both directions map here**.
   *
   * A row pointing at a parent that does not exist and a parent still holding
   * children produce the same SQLSTATE. They can be told apart by reading
   * `detail` — "is not present in" versus "is still referenced from" — and that
   * is rejected: Postgres translates its messages according to the server's
   * `lc_messages`, so the status code would silently depend on the server's
   * locale, and the same request would answer differently in another region
   * with nothing in this file to explain it.
   *
   * 409 is defensible for both, each being a conflict between the request and
   * the current state. This is the floor rather than the ceiling — a handler
   * that knows which direction it is in should catch the error and throw its
   * own named code first, per the pattern in `src/core/http/error-code.ts`.
   */
  '23503': CONFLICT,

  /** check_violation — a `CHECK` constraint the data must satisfy. */
  '23514': UNPROCESSABLE,

  /** not_null_violation — a required column arrived empty. */
  '23502': UNPROCESSABLE,

  /**
   * serialization_failure — only reachable under `SERIALIZABLE`, which nothing
   * here runs yet: concurrency is controlled with an optimistic `version`
   * column instead. Mapped anyway, because the alternative is a 500 on the day
   * someone opts in.
   *
   * 503 rather than a 4xx because the caller did nothing wrong and the retry
   * genuinely may succeed. Whoever first asks for `SERIALIZABLE` owes the
   * bounded retry that should sit in front of this.
   */
  '40001': UNAVAILABLE,

  /**
   * deadlock_detected — two transactions each waiting on a lock the other
   * holds, one chosen to die. Unlike `40001` this happens under the default
   * READ COMMITTED, so it is reachable today.
   */
  '40P01': UNAVAILABLE,

  /**
   * too_many_connections — the arithmetic in `env.schema.ts` under
   * `DB_POOL_MAX` did not hold.
   */
  '53300': UNAVAILABLE,

  /** lock_not_available — a `lock_timeout` fired waiting for a lock. */
  '55P03': UNAVAILABLE,

  /**
   * query_canceled — in this service, `DB_STATEMENT_TIMEOUT_MS` firing.
   *
   * 504 rather than 503 because it names what happened: something downstream
   * took too long. Left unmapped this is a 500, which pages someone for a slow
   * query — a limit *we* set doing exactly its job.
   */
  '57014': TIMED_OUT,
};

/**
 * SQLSTATE class `08`, connection_exception — every way the connection itself
 * failed once the server was already speaking. Matched by prefix because the
 * class has several members (`08006`, `08003`, `08001`, `08000`) that differ
 * only in which side noticed, and none of them changes the answer.
 */
const CONNECTION_CLASS = '08';

/**
 * Failures that never reached Postgres, so carry no SQLSTATE — the socket
 * refused, DNS missed, the network went away mid-statement.
 *
 * Two honest limitations, both worth knowing before adding to this set.
 *
 * This branch is **provenance-blind**. `AllExceptionsFilter` catches every
 * throwable in the process, so an `ECONNREFUSED` from some future outbound HTTP
 * call lands here too and is reported as 503. That is still the right status —
 * a dependency this request needed was unreachable — but it means the answer is
 * about dependencies in general rather than about this database specifically.
 *
 * **`EPIPE` is deliberately absent**, despite being the classic broken-socket
 * code. Its commonest cause in an HTTP service is writing to a connection the
 * *caller* has already closed — the client hung up — which is not a dependency
 * outage and must not be reported as one. It is also the code that makes
 * `severity` load-bearing in `isDriverError` below, so it stays unmapped on both
 * counts.
 */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
]);

/**
 * `pg-pool` throws these as bare `Error`s with no code at all, so the message is
 * the only thing to match on.
 *
 * Matching library text is fragile and normally worth avoiding. It is accepted
 * here because the failure mode is benign: if a future `pg` reworded these, the
 * match stops firing and the error falls through to a 500 — which is exactly
 * what happens today, so the worst case is losing an improvement rather than
 * breaking anything. That is not true of the `lc_messages` case above, where
 * matching text would produce a *wrong* answer rather than no answer.
 *
 * The first fires when `DB_ACQUIRE_TIMEOUT_MS` elapses waiting for a free
 * connection — the saturated-pool case `env.schema.ts` renamed that variable to
 * make legible.
 */
const POOL_FAILURE_MESSAGES = new Set([
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
]);

/**
 * The shape `pg` gives an error the *server* rejected, narrowed to what is read
 * here.
 *
 * Declared structurally rather than checked with `instanceof DatabaseError`,
 * and the reason is the same one `isHttpError` in
 * `src/core/http/all-exceptions.filter.ts` gives for its own check. `DatabaseError`
 * is defined in `pg-protocol`, a transitive dependency; `instanceof` compares
 * against one specific class object in memory, so two copies in `node_modules`
 * — which npm produces whenever versions conflict — means errors from one fail
 * the check against the other. Silently, with no error and no warning: every
 * database error would simply go back to being a 500.
 */
interface DriverErrorLike extends Error {
  code: string;
  severity: string;
  table?: string;
  constraint?: string;
  column?: string;
}

/**
 * SQLSTATE's alphabet: five characters, digits and upper-case letters only.
 */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * Whether a throwable came from the Postgres server.
 *
 * **`severity` is load-bearing and not decoration.** A check of "is an Error
 * with a five-character upper-case `code`" looks sufficient and is not: Node's
 * own `EPIPE` is exactly five upper-case characters and would match, mapping a
 * broken socket to whichever SQLSTATE it collided with. `severity` is a
 * Postgres wire-protocol field (`ERROR`, `FATAL`, `PANIC`) that nothing else in
 * Node sets, which makes the pair a fingerprint of the driver rather than a
 * coincidence of field names.
 */
function isDriverError(exception: unknown): exception is DriverErrorLike {
  if (!(exception instanceof Error)) return false;

  const { code, severity } = exception as Partial<DriverErrorLike>;

  return (
    typeof severity === 'string' &&
    typeof code === 'string' &&
    SQLSTATE.test(code)
  );
}

/** Whether a throwable is the connection failing rather than a statement. */
function isConnectionFailure(
  exception: unknown,
): exception is Error & { code?: string } {
  if (!(exception instanceof Error)) return false;

  const { code } = exception as { code?: unknown };

  return (
    (typeof code === 'string' && NETWORK_CODES.has(code)) ||
    POOL_FAILURE_MESSAGES.has(exception.message)
  );
}

/**
 * How many `cause` links `unwrap` follows. One is all Drizzle adds today; the
 * bound only stops a cyclic chain from spinning forever.
 */
const MAX_CAUSE_DEPTH = 5;

/**
 * The driver's own error, if `exception` wraps one; otherwise `exception`.
 *
 * Drizzle rethrows every failed query as a `DrizzleQueryError` whose message
 * is the SQL and whose `cause` is what `pg` threw, so the SQLSTATE and
 * `severity` this file reads sit one level down. Matched structurally, down
 * the `cause` chain, rather than with `instanceof DrizzleQueryError`, for the
 * reason `DriverErrorLike` gives, and so a second wrapper added later is
 * followed too.
 */
function unwrap(exception: unknown): unknown {
  let current = exception;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (isDriverError(current) || isConnectionFailure(current)) return current;
    if (!(current instanceof Error)) break;
    current = current.cause;
  }

  return exception;
}

/** Only the keys that are actually present, so no `undefined`s reach the log. */
function contextOf(error: DriverErrorLike): DriverContext {
  const context: DriverContext = { sqlstate: error.code };

  if (error.table !== undefined) context.table = error.table;
  if (error.constraint !== undefined) context.constraint = error.constraint;
  if (error.column !== undefined) context.column = error.column;

  return context;
}

/**
 * The constraint a unique violation broke, or `undefined` if this throwable is
 * not one.
 *
 * **This is the seam a handler needs to pre-empt the mapping**, and it exists
 * because the alternative is worse. `docs/database-decisions.md` decision 10
 * expects a handler that knows what it was doing to catch a violation and throw
 * its own named code — and the only signal saying *which* rule broke is the
 * constraint name, which is why `docs/schema-conventions.md` §1 requires
 * constraints to be named explicitly. Without this function the handler has to
 * re-derive `isDriverError`'s fingerprint itself: the `severity` check, the
 * SQLSTATE shape, the reason `instanceof DatabaseError` is unsafe across two
 * copies of `pg-protocol`. All of that reasoning lives here, and a second copy
 * of it in a feature folder would be the first to go stale.
 *
 * The caller it was added for is the idempotency replay in
 * `docs/schema-conventions.md` §9, where a unique violation on
 * `uq_*_idempotency_key` means *the retry worked* and every other unique
 * violation means 409. Those cannot be told apart any other way.
 *
 * It carries the name rather than answering a boolean, because a handler that
 * catches a violation almost always has to ask *which* one — a table often has
 * several unique constraints and they do not mean the same thing.
 *
 * **Note the two levels of `undefined`, which are different questions.** The
 * outer one means "not a unique violation" and is the one to branch on. The
 * inner `constraint` is `undefined` when Postgres reported no constraint name,
 * which happens for a violation raised by a bare unique index rather than by a
 * named constraint — so `{ constraint: undefined }` means *yes, a duplicate, and
 * I cannot tell you which rule*. Collapsing the two into one `string |
 * undefined` would make a nameless duplicate indistinguishable from something
 * that was never a duplicate at all, and the branch that silently takes the
 * wrong side of that is the idempotency replay.
 */
export function uniqueViolation(
  exception: unknown,
): { constraint: string | undefined } | undefined {
  const error = unwrap(exception);
  if (!isDriverError(error)) return undefined;
  if (error.code !== UNIQUE_VIOLATION) return undefined;

  return { constraint: error.constraint };
}

/**
 * The driver failure this throwable represents, or `undefined` if it is not one
 * — or is one this table has taken no position on.
 *
 * `undefined` rather than a 500-shaped result on purpose: deciding what an
 * unrecognised throwable renders as is `AllExceptionsFilter`'s job, and it
 * already does it. This function's only claim is about errors it recognises.
 */
export function describeDriverError(
  exception: unknown,
): DriverFailure | undefined {
  exception = unwrap(exception);

  if (isDriverError(exception)) {
    const rejection =
      REJECTION_BY_SQLSTATE[exception.code] ??
      (exception.code.startsWith(CONNECTION_CLASS) ? UNAVAILABLE : undefined);

    return rejection && { ...rejection, context: contextOf(exception) };
  }

  if (isConnectionFailure(exception)) {
    const { code } = exception;

    return {
      ...UNAVAILABLE,
      context: code === undefined ? {} : { driverCode: code },
    };
  }

  return undefined;
}
