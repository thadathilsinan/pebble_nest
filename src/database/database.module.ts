import {
  Global,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { installQueryLogging } from './query-logging';
import * as schema from './schema';

/**
 * Injection token for the connection pool. A symbol rather than the `Pool` class
 * so the token names *this service's* pool: injecting by class would make any
 * second pool added later — a read replica, a migration connection —
 * indistinguishable at every call site.
 */
export const POOL = Symbol('POOL');

/**
 * Injection token for the Drizzle instance. **This is what a repository injects**;
 * `POOL` is the lower layer and is needed only where Drizzle's DSL cannot reach
 * — `HealthController`'s `SELECT 1`, and the named raw-SQL methods
 * `docs/adding-a-feature.md` §3.4 allows.
 */
export const DB = Symbol('DB');

/**
 * The schema module as a type. Empty today — `schema.ts` declares no tables yet,
 * deliberately — which costs exactly one thing: `db.query.<table>` has nothing on
 * it. Every other capability is live now, and the first `pgTable` added to
 * `schema.ts` populates this with no change here.
 */
export type Schema = typeof schema;

/** The Drizzle instance, typed against this service's schema. */
export type Db = NodePgDatabase<Schema>;

/**
 * A transaction handle, as `db.transaction(async (tx) => …)` hands it over.
 *
 * Derived from `Db` rather than imported, because Drizzle exports no public name
 * for it — the type is structural and lives inside the `transaction` signature.
 * Deriving it means a Drizzle upgrade that reshapes the handle produces a type
 * error here rather than a name that silently no longer matches.
 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * A `Db` or a transaction on one — **the first parameter of every repository
 * method**, per `docs/adding-a-feature.md` §7.
 *
 * The rule that matters is the one this type exists to make enforceable: the
 * parameter is required and takes **no default**. `ex: Executor = this.db` reads
 * as a convenience and behaves as a trap — a service inside a transaction that
 * forgets to pass `tx` runs that statement on a *different connection*, outside
 * the transaction, with no type error, no runtime error, and no wrong answer
 * until something fails and half the writes are already committed. Required
 * means the compiler objects.
 *
 * It goes first rather than last for the same reason: a trailing required
 * parameter is easy to drop from a call that already passes three arguments; a
 * leading one cannot be omitted without an obvious compile failure.
 */
export type Executor = Db | Tx;

/**
 * What this service calls itself in `pg_stat_activity`. Without it every row is
 * a blank `application_name`, and the question "which of these connections is
 * the API and which is the migration runner?" has no answer at the moment you
 * need it — during an incident, looking at a lock you want to kill.
 */
const APPLICATION_NAME = 'pebble_backend';

/**
 * How long a transaction may sit open doing nothing before Postgres closes it.
 *
 * A constant rather than a variable because it is not an environment's business
 * to tune: an idle transaction is a bug in every environment. It also holds
 * every lock it has taken while doing nothing, which blocks writers, blocks DDL,
 * and pins the oldest snapshot so autovacuum cannot reclaim dead rows. That last
 * one is how an idle connection degrades a database it is not even querying.
 *
 * Comfortably above `DB_STATEMENT_TIMEOUT_MS`, since this is meant to catch a
 * transaction the *application* forgot to close, not a statement Postgres is
 * still working on.
 */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

/**
 * Owns the connection pool and its lifecycle, and the Drizzle instance built on
 * it.
 *
 * Two tokens, layered rather than alternative: `POOL` is the connection pool,
 * `DB` is Drizzle over that same pool. A repository injects `DB`; `POOL` is for
 * the cases Drizzle's DSL does not cover.
 *
 * `@Global()` matches `AppConfigModule`: a pool is process-wide infrastructure,
 * and making every module import a module to reach it is ceremony. Note what
 * that does *not* settle — whether a service may hold the pool at all, or
 * should be handed a repository interface instead, is still open. Reachable
 * everywhere is not permission to reach for it.
 */
@Global()
@Module({
  providers: [
    {
      provide: POOL,
      inject: [ENV, PinoLogger],
      useFactory: async (env: Env, logger: PinoLogger): Promise<Pool> => {
        const pool = new Pool({
          // Carries host, port, credentials, database and `sslmode` — validated
          // in `env.schema.ts` before this runs, so a malformed one never gets
          // here.
          connectionString: env.DATABASE_URL,
          max: env.DB_POOL_MAX,
          connectionTimeoutMillis: env.DB_ACQUIRE_TIMEOUT_MS,

          // These are session settings, applied by `pg` to each connection as
          // it opens and in force for that connection's life. That is why they
          // belong here and not on individual queries: a query that forgets to
          // set them is the one that runs away.
          application_name: APPLICATION_NAME,
          statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
          idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,

          // Every timestamp in this schema is `timestamptz`, which stores an
          // absolute instant and retains no zone — so values read through the
          // driver are correct whatever this is set to. What the session zone
          // does decide is `date_trunc` and `EXTRACT`, which bucket a
          // `timestamptz` *in the session's zone*. `date_trunc('day',
          // created_at)` therefore has no single answer: its day boundary moves
          // by whatever offset the server was configured with, so the same
          // report is right on a machine set to UTC and quietly wrong on one
          // that is not, with no error in either case.
          //
          // Pinned here rather than assumed of the environment, on the same
          // argument as the DSN: configuration this service depends on is
          // asserted by it, not hoped for. Note the reach — this covers the
          // application's connections only. `drizzle-kit` and psql connect with
          // the raw DSN and do not get it, so the same bucketing query run by
          // hand can disagree with the one the app ran.
          options: '-c timezone=UTC',
        });

        // A pool emits errors from connections sitting idle in it — the database
        // restarted, a firewall dropped the connection — with no query to attach
        // them to. Node treats an unhandled 'error' on an EventEmitter as fatal,
        // so without this listener a routine database restart *takes the process
        // down*, killing something that was perfectly able to carry on. `pg`
        // discards the broken connection and opens a fresh one on the next
        // request; the log line is all this needs to do.
        pool.on('error', (error) => {
          new Logger(DatabaseModule.name).error(
            { err: error },
            'idle database connection failed',
          );
        });

        // Installed before the first connection is opened, so the boot check
        // below is itself the first statement it times — which makes a
        // misinstalled wrapper visible in the boot log rather than on the first
        // request. See `query-logging.ts` for why it hooks `connect` rather
        // than replacing `pool.query`.
        installQueryLogging(pool, logger, env.DB_SLOW_QUERY_MS);

        // One attempt, no retry, and no waiting for the database to appear.
        // A failure here rejects `NestFactory.create`, which `main.ts` already
        // catches, logs as fatal and turns into `exit(1)`. That path needs no
        // code here — and no cleanup either, since the process is about to
        // end.
        //
        // The point is to distinguish two failures that look identical at
        // runtime. A wrong DSN, a wrong password, a firewall: these never fix
        // themselves, and a process that starts anyway reports healthy while
        // being incapable of serving a single request. A database that is merely
        // down right now does fix itself — and is handled by the other half of
        // this decision, where the pool reconnects and readiness reports 503
        // without the process ever exiting.
        const client = await pool.connect();

        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }

        // Buffered until pino exists — `main.ts` passes `bufferLogs: true`
        // precisely so lines written during module construction are not the
        // unparseable half of a boot log.
        new Logger(DatabaseModule.name).log(
          `connected to database, pool max ${env.DB_POOL_MAX}`,
        );

        return pool;
      },
    },
    {
      provide: DB,
      // Built on `POOL` rather than given its own `connectionString`, and that is
      // the whole design of this provider. Drizzle checks clients out of the pool
      // it is handed, so everything already established one layer down applies to
      // every Drizzle query for free: `DB_POOL_MAX`, `statement_timeout`,
      // `idle_in_transaction_session_timeout`, the `application_name` that makes
      // a row in `pg_stat_activity` identifiable, the UTC session zone, and the
      // per-statement timing that `installQueryLogging` emits under the request's
      // `reqId`. A second `drizzle(connectionString)` would be a second pool
      // sharing none of it — and the first symptom would be connection-count
      // arithmetic that no longer adds up.
      //
      // It also inherits the boot-time connectivity check: this factory cannot
      // run until the `POOL` factory has resolved, which it only does after
      // `SELECT 1` has come back.
      inject: [POOL],
      // `casing` is deliberately not set. Drizzle can derive `created_at` from
      // `createdAt` automatically, but `docs/schema-conventions.md` §1 commits to
      // naming the column explicitly — `createdAt: timestamp('created_at')` — and
      // turning both on means two mechanisms decide one name, where the implicit
      // one silently wins for any column whose explicit name was forgotten.
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [POOL, DB],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  /**
   * Drains the pool on shutdown. `end()` stops handing out connections and waits
   * for the borrowed ones to come back before closing them, so a request already
   * in flight finishes rather than losing its connection mid-statement.
   *
   * Only reached on a signal because `main.ts` calls `enableShutdownHooks()`;
   * without it SIGTERM kills the process outright and Postgres is left to notice
   * the dropped connections on its own.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
