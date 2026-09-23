import { defineConfig } from 'drizzle-kit';

/**
 * Configuration for `drizzle-kit`, which is this project's entire migration
 * mechanism: it both generates migrations (`db:migrate:create`) and applies
 * them (`db:migrate`).
 *
 * That is a deliberate choice to keep the tooling small. A hand-written runner
 * came first and was dropped: it bought an advisory lock against two concurrent
 * migration runs and a `lock_timeout` on the migration session, and both were
 * given up in exchange for having no migration code to maintain. Those two
 * protections are procedural now rather than enforced, which is what a deploy
 * has to account for — never run two migration steps at once, and give a
 * migration that will contend for a lock its own `lock_timeout`.
 *
 * Unlike the generation-only version of this file, **this connects to the
 * database**. `dbCredentials` is load-bearing for `db:migrate`.
 */

// `drizzle-kit` does not read `.env` — it bundles this file and runs it with
// whatever environment it inherited, so without this `db:migrate` would try to
// connect to `undefined`. `process.loadEnvFile` is Node's own loader, which is
// why this needs no `dotenv` dependency.
//
// Both files, in the order `AppConfigModule` reads them, so a DSN that starts
// the app also migrates it. Node refuses to overwrite a variable that is
// already set, which makes `.env.local` win over `.env` and a real environment
// variable win over both — the precedence a deployment needs, where neither
// file exists.
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing is normal for at least one of these, and for both in production.
  }
}

export default defineConfig({
  dialect: 'postgresql',

  // Where generated SQL lands, alongside the `meta/` snapshots `drizzle-kit`
  // diffs against. Both are committed: the snapshot is what makes the next
  // `generate` produce a difference rather than the whole schema again.
  //
  // Also read at *apply* time, which matters for a deployment: these are files
  // on disk, not something compiled into `dist/`, so an artifact that omits
  // `drizzle/` will report success against a database it has not touched.
  out: './drizzle',

  // Currently a file with no tables in it, and it has to exist all the same:
  // `drizzle-kit` resolves this path before it does anything else and exits if
  // it finds nothing, including for commands that never read a schema.
  // `src/database/schema.ts` carries that explanation at the point someone
  // would open it asking why it is empty.
  schema: './src/database/schema.ts',

  // Empty string rather than a hard failure when `DATABASE_URL` is unset,
  // because `db:migrate:create` does not connect and should keep working in a
  // checkout that has no `.env` yet. The cost is that `db:migrate` reports a
  // connection error rather than a missing-configuration one.
  //
  // Note what is *not* happening here: this DSN is not checked against
  // `envSchema`, which is where the application's rules about scheme, host and
  // a mandatory `sslmode` live. `drizzle-kit` connects with whatever it is
  // given. A DSN the application would refuse to boot on can still migrate.
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },

  migrations: {
    // `drizzle-kit` numbers migrations `0000_`, `0001_` by default, and
    // sequential integers collide the moment two branches each add one — both
    // authors pick the next free number, and the merge is silently wrong rather
    // than conflicted.
    //
    // Timestamps do not collide. What they do not fix is `meta/_journal.json`,
    // which both branches still append to and which therefore still conflicts
    // on merge. Resolve one by keeping *both* entries ordered by their `when`
    // value and renumbering `idx` from zero without gaps — the order they end
    // up in is the order they run in, and a migration left sitting before one
    // the database has already applied never runs at all.
    prefix: 'timestamp',

    // Both are `drizzle-kit`'s defaults, written out because they name the
    // table recording which migrations this database has applied — the thing
    // you query by hand to check state, and the thing any least-privilege role
    // added later has to be granted on explicitly.
    schema: 'drizzle',
    table: '__drizzle_migrations',
  },
});
