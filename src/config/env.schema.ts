import { z } from 'zod';

/**
 * Whether a string is a bare origin — scheme, host and optional port, and
 * nothing else. `new URL(value).origin` discards any path, query or fragment
 * and drops the trailing slash, so a value only round-trips if it was already
 * bare.
 *
 * The trailing slash is why this exists. `https://app.example.com/` is a
 * natural thing to write and matches nothing: browsers send
 * `Origin: https://app.example.com`, so an exact-match allowlist rejects every
 * request while the server behaves exactly as configured. The failure surfaces
 * in a browser console, not in a log. Here it is a boot error instead.
 */
function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * The `sslmode` values a `DATABASE_URL` may carry. Deliberately two, where libpq
 * defines six.
 *
 * `node-postgres` does not implement libpq's semantics by default. It treats
 * `prefer`, `require` and `verify-ca` as *deprecated aliases for full
 * verification*, warns on every connect, and documents that their meaning will
 * change to libpq's in a future major. So `require` here is not the "encrypt but
 * do not verify" it reads as; it is `verify-full` plus a warning plus a pending
 * behaviour change. Naming only the two whose meaning is stable means nobody
 * writes a value whose behaviour is scheduled to move underneath them.
 *
 * The rejected values are still worth knowing: `prefer` and `allow` fall back to
 * plaintext silently when TLS is unavailable, which makes "is this connection
 * encrypted?" unanswerable from configuration alone. `verify-ca` checks the
 * certificate chain but not the hostname, so any certificate that CA ever issued
 * is accepted. Neither is a defensible position for a production service.
 *
 * A private CA needs no variable: `node-postgres` reads `sslrootcert=/path/ca.pem`
 * from the DSN and loads the file, so the connection string stays the only
 * authority even in that case.
 */
const SUPPORTED_SSL_MODES = ['disable', 'verify-full'] as const;

/**
 * Why the connection string is unusable, or `null` if it is fine.
 *
 * A message rather than the boolean `isBareOrigin` returns, because a DSN has
 * five separate ways to be wrong and "Invalid DATABASE_URL" sends you to read
 * this file to find out which one you hit. The string is the whole value here:
 * this error is the first thing anyone sees on a fresh checkout.
 */
function describeDsnProblem(value: string): string | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return 'Must be a connection URL like postgresql://user:password@host:5432/database?sslmode=disable';
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    return `Scheme must be postgresql: or postgres:, not ${url.protocol}`;
  }

  if (!url.hostname) {
    return 'Must name a host';
  }

  // `new URL('postgresql://host:5432')` parses happily with an empty path, and
  // `pg` would then connect to a database named after the user — a real database
  // that is almost never the intended one.
  if (url.pathname.replace(/^\//, '') === '') {
    return 'Must name a database, as the path segment: …:5432/app';
  }

  const sslMode = url.searchParams.get('sslmode');

  // Absent rather than wrong, and called out separately, because the default is
  // the dangerous case: with no `sslmode` the driver connects in plaintext, and
  // a DSN that simply forgot to mention TLS looks identical to one that decided
  // against it. Requiring the parameter makes the choice legible in the value.
  if (sslMode === null) {
    return `Must set sslmode explicitly — one of ${SUPPORTED_SSL_MODES.join(', ')}. Encryption is not something to leave to a default`;
  }

  if (
    !SUPPORTED_SSL_MODES.includes(
      sslMode as (typeof SUPPORTED_SSL_MODES)[number],
    )
  ) {
    return `sslmode must be one of ${SUPPORTED_SSL_MODES.join(', ')}, not ${sslMode}. Use disable only where the database is on this machine`;
  }

  return null;
}

/**
 * The single source of truth for this service's configuration: every environment
 * variable the app reads is declared here with its coercion, constraint and default.
 *
 * `process.env` holds strings, so anything non-string needs `z.coerce`.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  /**
   * Pino's level names, in pino's own order. `silent` disables logging outright
   * and is what test runs want; `info` is the floor a production process should
   * ever be set to.
   */
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  /**
   * Origins allowed to make cross-origin browser requests, comma-separated.
   *
   * Empty — the default — disables CORS outright rather than allowing anything,
   * so a deployment has no cross-origin caller until someone names one. `*` is
   * not special-cased and fails validation: an allowlist is the whole point, and
   * a public API should be a deliberate code change rather than an env value.
   *
   * The split happens here because this file is the only place a variable's
   * shape is decided, which is what lets consumers inject a `string[]` and never
   * see the comma-separated form.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(
      z.array(
        z.string().refine(isBareOrigin, {
          message:
            'Must be a bare origin like https://app.example.com — no trailing slash or path',
        }),
      ),
    ),
  /**
   * How long one request may occupy a handler before the caller is answered with
   * a 504.
   *
   * The gap this closes: `DB_ACQUIRE_TIMEOUT_MS` and `DB_STATEMENT_TIMEOUT_MS`
   * bound one *statement* each, and nothing bounded a *request*. Two sequential
   * queries that each sit just inside their limits take twice as long as either,
   * and a handler doing no database work at all — a regex, an await on something
   * external, a loop — was unbounded. So the caller's own patience was the only
   * limit, and a client that gives up still leaves this process working.
   *
   * 15s rather than the 10s those two sum to, so that a request legitimately
   * spending its full database budget is not cut off by the very limit meant to
   * catch the things that have no budget.
   *
   * **Read what this does not do.** It stops *waiting* and answers; it does not
   * cancel the work. The statement carries on until `statement_timeout` kills it
   * and the promise settles into nothing — so this protects the caller and the
   * connection it was holding, not the database. Cancelling properly needs the
   * work itself to be abortable, which is a per-handler concern. A timeout firing
   * is therefore a bug report, not a tuning signal: something took longer than
   * anything here should.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * How to reach Postgres, entire: host, port, credentials, database and TLS
   * mode in one string.
   *
   * **The only variable here with no default**, which breaks the property the
   * rest of this schema has and `.env.example` used to advertise. Every other
   * variable has a defensible default because a wrong guess is recoverable — the
   * port is free, the log level is noise. There is no defensible default for
   * *which database this service writes to*. A localhost fallback would mean a
   * misconfigured production deployment silently connects somewhere else, or
   * nowhere, instead of refusing to start; that trade is not close.
   *
   * One string rather than six variables because it is what `psql`, `pg_dump`
   * and `drizzle-kit` all read. Splitting it would give the app one description
   * of this database and every other tool a second.
   */
  DATABASE_URL: z.string().superRefine((value, ctx) => {
    const problem = describeDsnProblem(value);

    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  }),
  /**
   * Connections this instance holds open.
   *
   * The arithmetic that matters: `DB_POOL_MAX` × instance count must stay under
   * the server's `max_connections` (100 by default), with room left over for
   * migrations, monitoring and a human with `psql` during an incident — which is
   * exactly when the pool is also at its fullest. Four instances at 10 is 40 of
   * 100, which leaves that room. Twelve instances at 10 does not, and the first
   * symptom is the migration that cannot get a connection to fix the problem.
   *
   * Bigger is not faster. Postgres runs one process per connection, so past the
   * point where the server's cores are busy, more connections buy context
   * switching rather than throughput.
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /**
   * How long a caller waits for a connection before giving up.
   *
   * Named for *acquiring* rather than connecting, and the name is deliberate.
   * In `node-postgres` this single setting covers two different situations:
   * opening a new connection, and queueing for a busy pool to hand one back.
   * The second is the one you will actually see, and it fires
   * while the database is entirely healthy and merely saturated. A variable
   * called "connect timeout" makes that read as "the database is unreachable",
   * which sends whoever is holding the pager to investigate the wrong system.
   */
  DB_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /**
   * Server-side cap on a single statement, applied to every connection the pool
   * opens.
   *
   * This is a safety limit, not a performance setting. Postgres cancels the
   * statement, which releases the locks it held — and a query holding locks
   * indefinitely is what turns one slow request into a stalled service and a
   * migration that cannot acquire its own lock.
   *
   * 5s is a starting value chosen with no real query to calibrate against.
   * Erring tight is the safer direction: too tight surfaces as a loud, specific
   * error on one endpoint, while too loose surfaces as everything degrading at
   * once. *Revisit when a legitimate query first exceeds it* — and revisit by
   * looking at the query.
   */
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /**
   * How long a statement may take before its log line is raised from `debug` to
   * `warn`.
   *
   * This changes nothing about how the query runs — only whether anyone hears
   * about it. It is the early-warning half of the pair whose late half is
   * `DB_STATEMENT_TIMEOUT_MS`: that one is the cliff a runaway query falls off,
   * this one is the trend you can watch approach it. Well under the timeout for
   * exactly that reason — set them close together and the warning arrives at the
   * same moment as the failure it was supposed to precede.
   *
   * 500ms is a starting value with no real query to calibrate against, chosen
   * as roughly the point where a single statement is a visible share of a
   * request a human is waiting on. *Revisit once real queries exist* — too low
   * and the warnings are ignored, which is the same as not having them.
   */
  DB_SLOW_QUERY_MS: z.coerce.number().int().positive().default(500),
});

export type Env = z.infer<typeof envSchema>;
