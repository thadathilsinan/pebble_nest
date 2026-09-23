# Database decisions

The choices the rest of this database layer is downstream of, each recorded
with the alternative it beat.

Nothing here is code. It exists because these choices are the kind that get made
implicitly — by installing a library, by typing a column — and then become
unrevisitable without anyone having decided anything. If you are about to
contradict one of these, that is fine, but do it by editing this file and saying
why, not by writing code that quietly disagrees with it.

---

## 1. Engine and host

**Choice: PostgreSQL 18, plain — a Postgres we run and connect to directly.**

**Rejected: Supabase-hosted Postgres.**

Supabase would have been less infrastructure to own, and that is a real benefit
this service is declining. What it costs is two things this design cares about
more than it cares about hosting convenience.

The first is the connection. Supabase's pooler in transaction mode breaks the
session-scoped features this design leans on: prepared statements have to be
disabled, advisory locks do not span statements, and `SET LOCAL` does not mean
what it reads like it means. Guarding a migration run with an advisory lock so
two runners cannot overlap is the obvious example; on a transaction-mode pooler
that lock silently does nothing. Choosing a direct connection means
`statement_timeout`, `idle_in_transaction_session_timeout`, advisory locks and
`SET LOCAL` all behave as the Postgres documentation describes them, and the
connection code needs no branch for the pooled case.

The second is authorization. On Supabase, a backend holding the service role
bypasses RLS entirely, which leaves you maintaining row-level policies that the
only caller never exercises — authorization half in the database and half in the
app, which is the failure mode, not a defence in depth. Here **RLS is not in
play at all**. Authorization lives in the application. The database enforces
*integrity* invariants (`docs/schema-conventions.md`) and *privilege* boundaries
(a runtime role holding DML with a separate role owning DDL, not yet built); it
does not enforce who may see which row.

Version 18 rather than 17 because `uuidv7()` is built in from 18 — see decision 4.
Below 18 the same choice would require the `pg_uuidv7` extension or generation in
application code.

---

## 2. Access layer

**Choice: Drizzle ORM with `drizzle-kit`, over `node-postgres`.**

**Rejected: Kysely + `pg`; Prisma; TypeORM.**

Scored on the three axes that matter here. 1–5, higher is better.

| | Migration ergonomics | Raw DDL expressiveness | Relationship to the zod contract |
|---|---|---|---|
| **Drizzle** | **4** | **3** | **4** |
| Kysely + `pg` | 2.5 | 5 | 4 |
| Prisma | 5 | 2 | 2 |
| TypeORM | 2 | 3.5 | 1.5 |

**Prisma** scores highest on migrations and is eliminated anyway. Its schema
language cannot express triggers, deferrable constraints, check constraints or
role grants — which is to say it cannot express any of the invariants in
`docs/schema-conventions.md` that are the entire reason this schema is worth
designing. Everything that matters would live in hand-edited SQL that
`schema.prisma` does not model, while still paying for a second generated type
system alongside the zod schemas that are already this service's contract.

**TypeORM** is eliminated on the third axis. Decorator-defined entity classes are
the furthest of the four from a codebase whose idiom is plain objects validated by
zod, and its migration generator has a long history of emitting diffs that have to
be read and corrected by hand every time.

**Kysely + `pg`** was the close contender and scores best where it matters most —
a 5 on raw DDL, because its migrations are `sql` templates and nothing is an
escape hatch. It loses on the first axis: the migration runner, the file naming,
the drift detection are all yours to build. That is work this project chose not to
own. Drizzle's 3 on DDL is the price of that, and decision 3 is where the price
gets itemised.

Drizzle earns its 4 on the third axis through `drizzle-zod`, which derives zod
schemas from the table definitions. Worth being precise about what that does and
does not buy: a row schema and an API request schema are different shapes, and
this service's existing zod schemas are the *API* contract. `drizzle-zod` removes
duplication at the row boundary. It does not unify the two.

### Known costs

Four, of which this decision anticipated one. The rest surfaced from reading
`drizzle-orm`'s migrator rather than trusting its documentation, and each is
reproduced against this repository in `docs/migrations.md`.

**Migration file naming — anticipated, and paid.** `drizzle-kit` numbers
migrations sequentially by default (`0000_`, `0001_`), which collides the moment
two branches each add one. `drizzle.config.ts` sets
`migrations: { prefix: 'timestamp' }`. The `_journal.json` file still
merge-conflicts between branches; that conflict is resolvable — keep both
entries — but recurring.

**Migrations apply by high-water mark, not by set difference.** The migrator
reads the single most recent `created_at` from its bookkeeping table and applies
only files strictly newer than it. A migration merged from a branch whose
timestamp predates one already applied is **silently skipped forever** — the run
reports "up to date" and the change never happens. This is strictly worse than
the journal conflict above, because a conflict announces itself and this does
not, and it is triggered by the same ordinary event: two branches merging.

Nothing detects it. A status command that did was written and then deliberately
removed — see *Tooling surface* below — so the check is the manual comparison in
`docs/migrations.md`.

**No checksum verification of applied migrations.** A sha256 of each file is
stored, and never read back. Editing an already-applied migration is therefore
undetected by the tool: databases that ran the old version keep it, new
databases get the new one, and nothing reconciles them. The rule against editing
an applied migration is enforced by review, not by the tooling.

**Every pending migration runs inside one transaction.** Good for atomicity — a
failure part-way through rolls the whole run back — and it costs
`CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses to run in a transaction
block.

There is a second thing it costs, and this one is sharper because it is not a
refusal but a divergence between environments. `ALTER TYPE … ADD VALUE` may run
inside a transaction, but **the added value cannot be used until that transaction
commits**. So the ordinary sequence — one migration adds an enum value, a later
one backfills rows to it — applies cleanly to a database where the first already
ran, and **fails from an empty one**, where both are pending in the same
transaction. A migration set that works in production and cannot build a fresh
database is exactly the failure the from-empty check exists to catch, and it is
why `docs/schema-conventions.md` §5 chooses check-constrained text over native
enums.

None of these overturns the decision. Kysely would have meant writing the whole
runner rather than living with someone else's, and all four are *detectable* by
someone who knows to look — which is why they are written down here rather than
left to be met during an incident.

### Tooling surface: `drizzle-kit` only

**Choice: use `drizzle-kit` for both generating and applying migrations. No
migration code is maintained in this repository.**

**Rejected: a migration runner of this project's own.**

The runner was not hypothetical — it was built and verified, taking an advisory
lock so two runs could not overlap, setting `lock_timeout` so blocked DDL could
not stall the service, and adding the status command the two costs above call
for. It was then removed, deliberately, in favour of ~110 fewer lines to
maintain and one less thing between this project and its dependency.

What that trades away is recorded in `docs/migrations.md` under *What this setup
does not protect you from*, and summarised here because it is the sort of thing
a later reader will assume was overlooked:

- **No lock.** `drizzle-kit`'s CLI contains no reference to `pg_advisory`. Two
  concurrent migration runs are prevented by procedure — one person, one
  pipeline — and by nothing else. A lock cannot be expressed as configuration,
  because it is a decision taken between two statements rather than a setting.
- **No `lock_timeout`.** Recoverable without code if it becomes a problem: a
  DSN can carry `options=-c lock_timeout=3000`. That needs a second
  `DATABASE_URL`, since the value is wrong for a request-serving pool.
- **No status command**, so the two costs above are checked by hand.
- **The migration DSN is not validated by `envSchema`.** `drizzle-kit` connects
  with whatever it is given, so a DSN the application would refuse to boot on
  can still migrate.

The reason this is defensible: every item is either procedural or detectable,
and none of them is a correctness property of the *migrations themselves* —
those are still atomic, still ordered, still recorded. The reason it is worth
writing down: three of the four become invisible the moment nobody remembers
they were traded.

---

## 3. Schema ownership direction

**Choice: code-first, with a declared SQL escape hatch.**

**Rejected: SQL-first — hand-written DDL with types generated back from the
database.**

The TypeScript schema is the source of truth for the parts Drizzle's DSL can
express: tables, columns, defaults, primary and foreign keys, uniques, indexes,
and check constraints. `drizzle-kit generate` produces migrations from it.

Everything the DSL cannot express is hand-written SQL inside the generated
migration file. That is the escape hatch, and for most schemas it is not a rare
case — it is where the invariants that matter most live: triggers, deferrable
constraints, role grants, `CREATE INDEX CONCURRENTLY`.

SQL-first is the better fit on expressiveness alone and was rejected for
coherence. Drizzle was chosen *for* its generation; running DDL by hand and
generating types back from the database would mean the TS schema and the SQL
both claim to be authoritative, which is worse than either direction on its own.

### The rule this creates

**Objects created through the escape hatch are invisible to `drizzle-kit`'s
snapshot.** They are applied, they persist, and nothing regenerates or drops
them — but the TypeScript schema is not a complete description of the database,
and anyone who reads it as one will be wrong about exactly the constraints that
matter most.

So: every object that exists only in a migration gets listed below, in this file,
as it is added. The register is the thing that keeps the gap between the TS
schema and the real schema visible instead of latent.

**Objects living only in migrations:**

| object | created by | what it is |
|---|---|---|
| `set_updated_at()` | `drizzle/20260901154040_set_updated_at.sql` | `BEFORE UPDATE` trigger function stamping `NEW.updated_at` with the transaction time. See `docs/schema-conventions.md` §3. |

The **triggers that attach it** are equally invisible to the snapshot, and there
are none yet because there are no tables. Rather than a row per table here — a
list that would be stale the first time someone forgot to update it — they are
named `trg_<table>_updated_at` by convention and enumerated from the database
itself:

```sql
SELECT tgrelid::regclass AS table_name, tgname
FROM pg_trigger
WHERE NOT tgisinternal
ORDER BY 1;
```

Anything appearing there that this file does not explain is the gap this register
exists to make visible.

---

## 4. Identifier strategy

**Choice: UUIDv7, as a `uuid` primary key defaulted by Postgres 18's `uuidv7()`.
One column — the primary key is also the id the API exposes.**

**Rejected: `bigserial`, and UUIDv4.**

`bigserial` is rejected because a sequential public id leaks volume: anyone
holding two ids knows how many rows were created between them. The usual repair —
keep `bigserial` as the primary key and add a separate public identifier — is
rejected too, because it gives every table two identities and makes every query
and every foreign key a small choice about which one is meant.

UUIDv4 is rejected on write behaviour rather than privacy. Random ids scatter
inserts across the whole B-tree, fragmenting pages and hurting cache locality.
UUIDv7 is time-ordered, so inserts stay at the right edge of the index and behave
much more like a sequence, while still not being one you can count with.

---

## 5. Boot behaviour on an unreachable database

**Choice: fail fast at boot; never exit after it.** The pool provider opens one
connection and runs `SELECT 1` while the module graph is being built. If that
fails, the exception rejects `NestFactory.create`, `main.ts` logs it as fatal and
the process exits 1. Once the app is listening, no database failure ever ends the
process again — readiness reports 503 and the instance drains.

**Rejected: fail fast always, and lazy connect.**

The two options on the table each treated one situation correctly and the other
badly, because "the database is not there" is two different problems wearing the
same error message.

A **wrong DSN, a wrong password, a missing network route** is a
misconfiguration. It will not fix itself. Starting anyway means a process that
passes its own liveness check, accepts traffic, and fails every request — and
the deploy that introduced it goes green. That is the case for failing at boot,
and it is the same argument `env.schema.ts` already makes for `CORS_ORIGINS`:
configuration is checked when it is loaded, not when it is first needed.

A **database that is down for ninety seconds** is not that. It will fix itself.
Crashing through it converts a recoverable dependency outage into a restart
storm across every instance, at the exact moment the database is least able to
absorb a reconnect stampede. Worse, a crash-looping process cannot answer the
probe that would have told an orchestrator to stop sending it traffic.

*Fail fast always* handles the first and mishandles the second. *Lazy connect*
handles the second and mishandles the first — and inverts the property this
codebase already has, where bad configuration stops the boot rather than
surfacing later as a runtime error.

So the rule is split by *when*, which is the only signal that reliably separates
the two: before listening, any failure is presumed to be configuration and is
fatal. After listening, any failure is presumed transient and is reported.

### What this costs, and where it is paid

`AppModule` can no longer be constructed without a reachable Postgres. That
includes `Test.createTestingModule`, so `npm run test:e2e` gained an external
prerequisite it did not have before — `docker compose up -d --wait`. This is a
real bill, and the boot behaviour decided here is what charges it rather than
any future test harness. It is also why `docker-compose.yml` exists in this
repository at all.

Note that this does not pre-empt the still-open question of test isolation. That
one is about the *test* database — whether the suite talks to this instance or to
a throwaway it provisions itself. This file only settles that a development
database exists and how the app behaves when it does not.

### The part that is easy to get wrong

"Never exit after boot" is not achieved by declining to call `process.exit`. A
`pg` pool emits `error` events for connections that break while idle — a
database restart, a dropped TCP session — and an `error` event with no listener
is a **fatal** unhandled exception in Node. Without a listener on the pool, the
second half of this decision silently does not hold, and the way you find out is
a routine database restart taking down every instance. `database.module.ts`
registers that listener, and the log line it writes was observed during a
stop/start of the container while the process stayed up.

---

## 6. Down migrations

**Choice: none. A migration only goes forward; a mistake is corrected by a new
migration.**

**Rejected: a paired `down` script for every migration.**

The instinct being overridden is a strong one, so the argument matters more than
usual here.

A down migration promises reversal and cannot deliver it. If the up added a
column and the application has been writing to it for two hours, the down drops
that column and the data in it. That is a second destructive change wearing the
word "undo" — and it is at its most dangerous in exactly the situation that
prompts someone to reach for it, which is a production incident where the
instinct is to get back to a known state quickly.

The reversal is also usually unnecessary. Most bad migrations are additive, and
an unused column or index harms nothing while a forward fix is written. The ones
that are not additive are the ones a down migration cannot honestly reverse
anyway.

What is rejected alongside it is the *discipline* a down migration is sometimes
argued for: that writing one forces you to think about reversibility. That
thinking is real and belongs in the expand/contract sequence in
`docs/migrations.md`, which achieves reversibility by making each step
individually safe — a nullable column can simply be left, a dual-write can
simply be stopped — rather than by promising to unwind a step after the fact.

**What this costs.** There is no single command that returns the schema to
yesterday. Recovering from a migration that destroyed data means restoring from
a backup, which is why backups and a rehearsed restore are non-optional here
rather than hygiene. Accepting that cost is the point: it puts the recovery path
where it actually is, instead of leaving a `down` script to be mistaken for one.

---

## 7. Concurrency control

**Choice: optimistic concurrency — a `version` column on rows that can be
concurrently modified, with every update conditional on the version read.**

**Rejected: pessimistic row locks (`SELECT … FOR UPDATE`) as the default;
`SERIALIZABLE` isolation as the default. Both survive as named exceptions.**

The full reasoning, the exceptions and the rule for which tables carry the column
are in `docs/schema-conventions.md` §10. Recorded here is the choice, why the
alternatives lost, and what accepting it costs.

The problem is the lost update: two requests read a row, both write, the second
overwrites the first, and nothing errors. A transaction does not prevent it —
PostgreSQL's default Read Committed isolation guarantees you never read
uncommitted data, not that what you read is still true when you write. The
exposure is read-modify-write split across statements, which is what happens as
soon as the modify step involves application logic.

Both rejected options require the read and the write to sit inside **one
transaction**. This is an HTTP service whose dominant mutation pattern is read in
one request, write in a later one — a user opens a form and submits it minutes
later — and no transaction spans that. Optimistic concurrency is the only one of
the three that works when a human sits between the read and the write, because
the version travels with the data rather than being held as server state.

It also fails visibly. Zero rows updated is unambiguous, and a `409` carrying the
current state is an honest answer to the caller. The failure it replaces —
silently discarding a write — is the one you learn about from a customer.

**What it costs.** Three things, and the first is the one that bites.

Every update must carry `AND version = $n`, and **forgetting is silent**: the
`UPDATE` succeeds and clobbers. No database mechanism can require a `WHERE`
clause, so unlike every other rule in `docs/schema-conventions.md` this one has
no constraint standing behind it. It shares that property with the soft-delete
filter, and both have the same single point of enforcement — the repository
boundary of decision 8. If that boundary is not mandatory, neither rule is
enforced anywhere except in review. `docs/schema-conventions.md` closes with
both obligations stated as such.

Second, it pushes work onto the client: a `409` means re-read and decide, which
is an API contract obligation from the first endpoint rather than a server-side
detail. Third, it protects a single row and says nothing about invariants across
rows — which is why the two exceptions above are written down rather than left to
be rediscovered by whoever first needs one.

---

## 8. Repository boundary and transaction propagation

**Choice: services receive repositories, not the database client. Transactions
are an explicit unit of work, passed as a parameter. Nested calls join the outer
transaction; savepoints are a named exception.**

**Rejected: services holding the ORM client directly; an implicit request-wide
transaction; propagating the transaction through `AsyncLocalStorage`.**

No tables exist yet, so this decision ships with no repositories. That is
deliberate and the split is worth stating plainly: **the decision is recorded
now, the code arrives with the first table.** A repository base class with no
repository cannot be verified — a builder chain that type-checks says almost
nothing about the SQL it emits — which is the same argument that declined shared
column helpers in `docs/schema-conventions.md`. What could not wait is the
decision itself, because `docs/schema-conventions.md` closes by naming this as
the thing two of its rules depend on.

The shape the code takes when it does arrive is now written down:
`docs/adding-a-feature.md` §7 is the executor type and the transaction rule, and
§3.4 is what a repository may and may not do. That is still prose rather than a
type — what changed is that the first repository has a specification to be
checked against rather than a paragraph to interpret.

**Why repositories rather than the client.** Two rules in
`docs/schema-conventions.md` have no constraint standing behind them: the
soft-delete filter (§8) and the version predicate (§10). A query that forgets
`deleted_at IS NULL` returns deleted rows *successfully*, and an update that
forgets it edits a deleted row; an update that forgets `AND version = $2` clobbers
a concurrent write *successfully*. A repository is where both can be applied once
instead of remembered everywhere, which is what makes them rules rather than
aspirations. Choosing the other way would not have been neutral — it would have
downgraded both to conventions enforced by review, and `schema-conventions.md`
would have had to say so.

**A correction to how this was argued.** This entry originally said the two rules
"cannot be enforced by the database at all", and that claim was wrong — it
exempted them from the principle in `schema-conventions.md` §7, that an invariant
the database can enforce it does, without testing them against it. The
soft-delete filter *is* enforceable, by exposing live rows through an
auto-updatable view `WITH CHECK OPTION` and granting the runtime role the view
rather than the table; the version predicate is partly enforceable, by a
`BEFORE UPDATE` trigger that rejects an update which failed to bump the column.
That section now carries both mechanisms and their costs.

The decision itself stands, for two reasons that do not depend on the overstated
claim. A repository is where both rules live *together*, and the view answers only
one of them. And the view's enforcement rests on a grant split between a DDL owner
and a runtime role, which decision 1 describes and **this project has not built** —
so until it exists, a view is a better convention rather than an actual guarantee.
What changes is the honest description: the boundary is where these rules are
applied, not the only place they *could* be.

**Why an explicit transaction rather than a request-wide one.** Middleware that
opens a transaction per request is less code at every call site and wrong in one
specific way: any slow work inside the handler — a payment provider, an email —
then happens with the transaction open, holding every lock it has taken.
`IDLE_IN_TRANSACTION_TIMEOUT_MS` in `database.module.ts` exists because that
pattern degrades a database it is not even querying. Explicit boundaries put the
decision in the code that owns the invariant.

**Why not `AsyncLocalStorage`.** This one is a finding rather than a preference,
and it is recorded so nobody spends the afternoon again. `nestjs-pino` stores a
`Store` *class* with exactly two fields, `logger` and `responseLogger`; a
transaction handle cannot go in it without mutating a class this project does
not own. And the lifetimes do not line up — its `run()` scope is the whole
request, a transaction's is a slice of one. The intent of reusing that context
rather than opening a second turned out to be achievable for **query logging**,
where the need is exactly request-scoped, and not achievable for transactions.
`src/database/query-logging.ts` is the half that was cashed.

**Isolation, and the retry that is not here.** The default is READ COMMITTED and
nothing opts into `SERIALIZABLE` yet, so **no bounded retry-on-`40001` wrapper
was written** — it would wrap nothing. It is owed by the first operation that
opts in. The 503 *mapping* for `40001` ships anyway, in decision 10, because
`40P01` deadlocks occur under READ COMMITTED too and a deadlock reaching a client
as a 500 is the same bug.

**What it costs.** Repositories are indirection, and indirection is only paid for
if the rules it centralises are actually applied there — a repository that
exposes a raw `query` escape hatch to everyone has the cost and none of the
benefit. So the escape hatch, when it arrives, should be deliberate and visible.
The second cost is that this decision is currently a paragraph rather than a
type: nothing in the codebase enforces it today, and the first repository is
where it becomes real or quietly does not.

---

## 10. Driver error mapping

**Choice: SQLSTATE mapped to a status and a stable code in one table, with fixed
messages; the driver's own text discarded and its identifying fields logged
instead. Handlers may pre-empt the mapping by catching and throwing their own
named code.**

**Rejected: mapping per constraint name; parsing the driver's `detail` text;
`instanceof DatabaseError` as the detection mechanism.**

Numbered 10 rather than 9 on purpose — 9 stays reserved for test isolation, so
that the numbers already cited from `database.module.ts` and
`schema-conventions.md` keep pointing at what they meant.

Before this, every constraint violation fell through `AllExceptionsFilter`'s last
branch and rendered as a 500. That is wrong for the caller, who is told the
server broke when it worked as designed and is implicitly told to retry something
that will fail forever; and wrong for us, because `pino-options.ts` logs 5xx at
`error` with a stack, so a duplicate signup becomes an error-level line and real
incidents get buried under routine user mistakes.

The full table is in `src/database/driver-error.ts`. Three choices in it needed
an argument.

**Foreign keys map to 409 in both directions.** An insert naming a missing
parent and a delete of a still-referenced parent share SQLSTATE `23503`. They
can be told apart by reading `detail` — "is not present in" versus "is still
referenced from" — and that was rejected, because Postgres translates its
messages according to `lc_messages`. Matching on that text would make the status
code depend on the server's locale: the same request, answered differently in
another region, with nothing in the source to explain it.

**Detection is structural, not `instanceof`.** `DatabaseError` is defined in
`pg-protocol`, a transitive dependency, and `instanceof` compares against one
class object in memory. Two copies in `node_modules` — which npm produces
whenever versions conflict — and errors from one silently fail the check against
the other, with every database error quietly reverting to a 500. This repeats the
call `isHttpError` already makes for the same reason. The fingerprint needs
`severity` as well as a five-character `code`: Node's own `EPIPE` is exactly five
upper-case characters and would otherwise match.

**Generic codes in the filter, specific codes at the throw site.** The filter
maps to `CONFLICT` and `UNPROCESSABLE_ENTITY` rather than to per-constraint codes
like `EMAIL_ALREADY_REGISTERED`. A registry mapping every constraint name to a
client-facing code would have to live in the HTTP layer and be kept in step with
every migration, from the wrong side of the seam. Instead a handler that knows
what it was doing catches the violation and throws its own code — the pattern
`src/http/error-code.ts` already documents — and this table is the floor for
everything nobody caught.

**What it costs.** Two things. The mapping is **provenance-blind**: the filter
sees every throwable in the process, so a connection failure from some future
outbound HTTP call is reported as 503 too. That is still the right status for
"a dependency was unreachable", but the answer is about dependencies in general
rather than about this database. And a driver 5xx keeps its message rather than
being replaced by the opaque one, which is a stated departure from the rule for
every other 5xx — the reasoning, and its visible consequence for
`HealthController`, is written at the branch itself.

---

## What these decisions settle elsewhere

Recorded here so they are not re-litigated later, and so that work which now has
no content is understood as deliberately dropped rather than forgotten:

- **Connection handling** — the transaction-mode pooler case does not apply.
  Direct connections, session mode. See decision 1.
- **Privilege boundaries** — RLS is not in play. Authorization is the
  application's, entirely. See decision 1.
- **The access seam** — `AsyncLocalStorage` is answered rather than dropped:
  reused for query logging, unavailable for transaction propagation. Retry on
  `40001` is deliberately unbuilt until something requests `SERIALIZABLE`. See
  decision 8.

## Deliberately still open

These are still to be decided, listed only so their absence here is not read as
an oversight: test isolation, which is why decision 9 is reserved rather than
filled. Concurrency control was on this list and is now decision 7; the
repository boundary was on it and is now decision 8 — though see that entry for
what it does *not* yet ship.

The migration work also left one thing deliberately undecided rather than
decided badly: **how this project runs CI**. It wants a job that migrates an
empty database and checks for drift, but this repository has no CI at all, and
introducing it is a decision about how the project tests itself rather than a
database decision. `docs/migrations.md` records what that job should check when
someone builds it.
