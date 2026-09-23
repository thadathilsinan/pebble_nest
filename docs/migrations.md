# Migrations — rules and runbook

How the shape of this database changes, and the rules that make a change safe
to apply to a database holding real data.

The mechanism is `drizzle-kit` and nothing else — no migration code is written
or maintained here. That choice is cheap in code and expensive in guarantees,
and this file is mostly about the second half: the protections it costs, and
what you have to do by hand instead.

---

## The two commands

| Command | Does | Touches the database |
|---|---|---|
| `npm run db:migrate:create` | Writes a new migration file from the TypeScript schema | no |
| `npm run db:migrate` | Applies everything pending | yes |

Both are `drizzle-kit` directly. Both run from the repository root, and both
read `DATABASE_URL` from `.env.local`, then `.env`, then the real environment.

There is deliberately no `db:migrate:status`: `drizzle-kit` has no such command,
and this project decided not to write one. The queries that answer the same
questions are in [Checking state by hand](#checking-state-by-hand), and you
should expect to run them — they cover failure modes the tool does not report.

---

## Writing one

**The routine case is code-first.** Edit `src/database/schema.ts`, then:

```
npm run db:migrate:create
```

`drizzle-kit` diffs your TypeScript against the snapshot in `drizzle/meta/` and
writes the SQL for you. **Read what it wrote.** It is a diff of a data model
produced by a tool that cannot know that dropping that column ends eight years
of history. This is a review step, not a formality.

**The escape hatch is hand-written SQL:**

```
npm run db:migrate:create -- --custom --name=add_updated_at_trigger
```

That writes an empty file for you to fill in. Decision 3 in
`docs/database-decisions.md` expects this to be common rather than exceptional —
triggers, deferrable constraints, grants and anything else Drizzle's DSL cannot
express all live here.

**Objects created this way are invisible to the snapshot `drizzle-kit` diffs
against.** They exist in the database and in the migration file, and nothing
regenerates or drops them. Add them to the register in
`docs/database-decisions.md` as you add them; that register is the only thing
keeping the gap between `schema.ts` and the real database visible.

---

## Applying one

**Locally:**

```
docker compose up -d --wait
npm run db:migrate
```

**On deploy — a separate step, before the new version starts.**

### Migrations never run at application boot

Not as a default to be overridden — as a rule.

Production runs several instances. A deploy restarts them together, so
boot-time migration means every instance attempting the same `ALTER TABLE` at
the same moment. With no lock anywhere in this setup (see below), that is not a
queue — it is several sessions racing the same DDL.

There is a second reason that outlives the first. A migration is the step most
likely to need a human: it is slow, it takes locks, and it is the thing you want
to run at 2pm rather than at whatever time an autoscaler decides to add an
instance. Coupling it to process start removes the ability to choose.

### What a deploy needs

- **`drizzle-kit` must be installed.** It is a devDependency, so a production
  image built with `npm ci --omit=dev` cannot run `db:migrate` at all. Either
  install devDependencies in the image, or run migrations from a controlled
  machine — a CI job or a maintenance container — that has the full tree and
  can reach the database.
- **It must run from the repository root**, because `drizzle/` is resolved
  relative to the working directory.
- **`drizzle/` must be present.** The SQL files are read at apply time, not
  compiled into `dist/`. A deployment that ships only `dist/` will report
  success against a database it never touched, which is the most dangerous way
  for this to fail.
- **Only one migration run at a time**, and that is on you — see below.

### `drizzle-kit migrate` reports success either way

It prints `migrations applied successfully!` whether it applied five migrations
or none. To find out what actually happened, query the table afterwards.

---

## What this setup does not protect you from

Recorded plainly because none of it is enforced. Every item here was a
guarantee at one point and was traded away for having no migration code to
maintain; the trade is defensible, but only if these are known.

### Nothing prevents two concurrent migration runs

There is no lock. `drizzle-kit`'s CLI contains no reference to `pg_advisory` —
it takes none. Two runs started together will both apply the same files, and
what that does depends entirely on the SQL: an `ALTER TABLE` may simply fail the
second time, or both may partially succeed.

**Procedurally:** one person, or one pipeline, runs migrations. Never trigger a
deploy while another is mid-migration. If you later find yourself unable to
guarantee that — a pipeline that can fire twice, several people deploying — that
is the signal to reconsider, because no amount of care substitutes for a lock.

### A migration can stall the whole service

There is no `lock_timeout`. DDL needs an exclusive lock on the table and cannot
have one while queries are reading it, so it waits — and every query arriving
afterwards queues *behind* it. A table nobody can read is an outage, and the
default wait is forever.

**Mitigations, in order of preference:**

1. Migrate during quiet periods, and keep migrations small.
2. Follow the lock-hazard list below, which is about avoiding long locks
   entirely.
3. If it becomes a real problem, a `lock_timeout` can be set without writing any
   code, by giving the migration its own DSN carrying it:
   `postgresql://…/app?sslmode=disable&options=-c%20lock_timeout%3D3000`.
   That needs a second `DATABASE_URL` distinct from the application's, since
   these values are wrong for a request-serving pool.

### Nothing detects an edited migration

`drizzle-orm` stores a sha256 of every migration file and **never reads it
back** — no code path compares a stored hash against the file on a later run.
Editing an already-applied migration is therefore completely silent: databases
that ran the old version keep it, new databases get the new one, and nothing
reconciles them.

The rule below is the only protection, and it is enforced by review.

### Nothing detects an unapplyable migration

See [The ordering hazard](#the-ordering-hazard). This is the sharpest item on
this page and the one most likely to bite, because an ordinary merge is all it
takes.

### The migration DSN is not validated

`envSchema` defines what a usable `DATABASE_URL` looks like for this service —
scheme, host, database name, a mandatory `sslmode` — and `drizzle-kit` does not
consult it. A DSN the application would refuse to boot on can still migrate.

---

## The rules

### An applied migration is never edited

Once a migration has been merged and applied anywhere, it is frozen. Fix it with
a *new* migration.

Editing it does not do what it appears to. Databases that already ran it keep
the old behaviour; databases created afterwards get the new one. Nothing
reconciles the two, and the difference is invisible until something depends on
it.

Before it is merged and applied, a migration is ordinary work in progress — edit
it freely, or delete it and regenerate.

Nothing enforces this. It is a review rule, and the hash comparison under
[Checking state by hand](#checking-state-by-hand) is how you confirm it held.

### No down migrations

Recorded as decision 6 in `docs/database-decisions.md`. Forward fixes only.

Worth restating here because "roll it back" is the instinct under pressure, and
this is the rule being overridden. A down migration that drops a column deletes
whatever was written to it — a second destructive change, not a reversal.

### Reference data is a migration; fixtures are not

Data the application cannot function without — lookup tables, required
reference rows — belongs in a migration. Every environment needs it, including
production, and it is part of the schema in every sense that matters.

Development and test fixtures belong in a script that never runs against
production. The failure this separates is a production database carrying test
rows that someone then treats as real.

No such script exists yet; it arrives with the first test that needs one.

### Everything pending applies in one transaction

A property of `drizzle-orm`'s migrator, and it cuts both ways.

Good: if the third of five migrations fails, the first two roll back with it. A
failed run leaves the database exactly as it was.

Costly: **`CREATE INDEX CONCURRENTLY` cannot be used**, because PostgreSQL
refuses to run it inside a transaction block. On a table small enough that a
blocking index build is acceptable, use a plain `CREATE INDEX`. On one that is
not, build the index outside the migration system as an operational task and add
a migration recording that it exists.

---

## The ordering hazard

**Read this twice.** It is silent, it is permanent, and merging two branches is
all it takes.

`drizzle-orm`'s migrator does not compute the set of unapplied migrations. It
reads the single most recent `created_at` from the bookkeeping table and applies
only files whose timestamp is **strictly newer** than it. Anything older is
skipped — not deferred, skipped, on that run and every run after it.

So:

1. You generate a migration at 10:00 on your branch.
2. A colleague generates one at 10:05 on theirs.
3. Theirs merges and deploys first. The high-water mark is now 10:05.
4. Yours merges. Its timestamp is 10:00, which is older.
5. **`npm run db:migrate` reports success and your migration never runs.**

This was verified against this repository: a migration creating a table was
placed behind the high-water mark, the migrator reported success, and the table
did not exist afterwards.

**Detecting it** is manual — see below. Do it after any merge that touched
`drizzle/`, and before any deploy.

**Fixing it:** make the migration new again. Delete the file and its
`_journal.json` entry, then regenerate so it gets a current timestamp. If it was
already applied to your *local* database, rebuild that from empty first.

**Preventing it:** rebase before merging rather than after, so your timestamp is
generated against an up-to-date main.

### Resolving a `_journal.json` conflict

Both branches append to the same array, so this file conflicts on most merges.
It is a known and accepted cost of decision 2.

Keep **both** entries, ordered by their `when` value, and renumber `idx` so it
counts from zero without gaps. Then check state by hand before doing anything
else — a conflict here is exactly what produces the ordering hazard above.

---

## Checking state by hand

There is no status command, so these are the substitutes.

**What has this database applied?**

```sql
SELECT id, created_at, to_timestamp(created_at / 1000) AS applied_for,
       left(hash, 12) AS hash
FROM drizzle.__drizzle_migrations
ORDER BY created_at;
```

**Is anything unapplyable?** Compare the high-water mark against the journal:

```sql
SELECT max(created_at) AS high_water_mark FROM drizzle.__drizzle_migrations;
```

Any entry in `drizzle/meta/_journal.json` whose `when` is **lower** than that
number, and which is not already in the table, will never apply. Regenerate it.

**Has an applied migration been edited?** Compare the stored hash against the
file:

```
shasum -a 256 drizzle/<tag>.sql
```

against the `hash` column for that migration's `created_at`. A difference means
the file changed after it was applied — the rule above was broken, and this
database and a fresh one now disagree.

---

## Lock hazards to avoid

Operations that look ordinary and lock a large table long enough to be an
outage. With no `lock_timeout` configured, avoiding these is the protection.

- **`ADD COLUMN` with a volatile default.** A constant default is cheap in
  modern PostgreSQL — stored as metadata. A volatile one (`now()`, `random()`,
  `gen_random_uuid()`) rewrites every row while holding an exclusive lock. Add
  the column nullable, backfill in batches, then set the default.
- **`CREATE INDEX` without `CONCURRENTLY`** blocks writes for the whole build.
  See the single-transaction note above for why `CONCURRENTLY` is unavailable
  inside a migration here.
- **`SET NOT NULL`** scans the entire table under an exclusive lock. Add a
  `CHECK (col IS NOT NULL) NOT VALID` constraint, `VALIDATE` it separately —
  validation takes a weaker lock — then set `NOT NULL`, which can use the
  validated constraint as proof.
- **Adding a foreign key** locks both tables and scans the child. Add it
  `NOT VALID`, then `VALIDATE CONSTRAINT` in a separate migration.
- **`ALTER COLUMN TYPE`** usually rewrites the table. Treat it as
  expand/contract: new column, backfill, switch, drop.

---

## Expand and contract

The sequence for changing shape without downtime. It exists because old and new
application code run **simultaneously** during a deploy, so any single migration
that both versions cannot tolerate breaks one of them.

Renaming `name` to `title`, in separate releases:

1. **Expand.** Add `title`, nullable. Both versions work: old ignores it, new
   tolerates nulls.
2. **Backfill.** Copy `name` into `title`, in batches for a large table.
3. **Dual-write.** New code writes both columns. Every row is now correct
   whichever version wrote it.
4. **Enforce.** `title` becomes `NOT NULL` — via the `NOT VALID` route above.
5. **Stop reading `name`.** Deploy code that only reads `title`. No schema
   change.
6. **Contract.** Drop `name`, once nothing has read it for long enough that a
   rollback would not need it.

Six releases to rename a column. The alternative is an outage of exactly the
length of your deploy, on a service somebody is depending on.

---

## Runbook

### A migration failed

1. **Nothing was applied.** The run is one transaction; a failure rolls all of
   it back. Confirm with the queries above.
2. **Read the error.** A lock wait that never returned means the table was busy;
   retry when it is quieter. A constraint violation means the migration is wrong
   about the data that exists, which is a different problem.
3. **Fix the file.** It has not been applied anywhere, so it is not yet
   immutable — edit it.
4. **Re-run.**

### A migration seems to have done nothing

`drizzle-kit migrate` reports success unconditionally, so "it said it worked" is
not evidence. Check the bookkeeping table. If the migration is absent and its
journal timestamp is below the high-water mark, you have hit the ordering
hazard.

### Someone else may be migrating right now

There is no lock to consult. Look for their session:

```sql
SELECT pid, application_name, state, query_start, left(query, 80)
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle';
```

Migration sessions do not identify themselves — `application_name` is set by the
application's pool, not by `drizzle-kit` — so judge by the query.

---

## Not yet automated

There is no CI in this repository, so nothing checks any of the above
automatically. Deliberately deferred rather than overlooked: introducing GitHub
Actions is a decision about how this project tests itself rather than a database
decision, and it deserves to be made on its own terms.

It matters more here than it would have otherwise. With no status command and no
lock, CI is the only place the silent failures could be caught mechanically.
When it arrives, it should:

- apply all migrations to an empty PostgreSQL and assert they succeed;
- assert that every entry in `_journal.json` ends up in
  `drizzle.__drizzle_migrations` — which catches the ordering hazard;
- re-hash each applied migration file and compare against the stored hash —
  which catches an edited migration;
- detect drift: generate from the committed schema and fail if a new migration
  appears, which catches a `schema.ts` change whose migration was never
  generated.

Until then, all four are manual.
