# Schema conventions

The rules the first real table inherits, decided once here rather than
differently in each of the first five migrations — which is what happens when
they are never decided at all.

**No tables ship with these rules.** This repository is a backend skeleton and
has no domain of its own; inventing one would be scaffolding for an application
that does not exist. So the code that consumes these rules is not here yet, and
the audience for this file is whoever adds the first table to a project built on
this skeleton.

Two things follow from that. Each rule states the alternative it beat, because a
rule whose reasoning is lost gets overturned by the first person who finds it
inconvenient. And where a rule has no constraint standing behind it, this file says
so plainly rather than implying a guarantee that does not exist — there are two of
those, and both are collected at the end, together with what *can* be made to
enforce them.

The four choices upstream of everything here — Postgres 18, Drizzle, code-first
with an SQL escape hatch, and UUIDv7 identifiers — are in
`docs/database-decisions.md`. Concurrency control (decision 7) is settled by
these conventions and recorded there too.

---

## 1. Names

### Identifiers are `snake_case`

Stated rather than argued. PostgreSQL folds unquoted identifiers to lower case:
`createdAt` in a `CREATE TABLE` produces a column actually named `createdat`, and
keeping the capital requires writing it quoted — `"createdAt"` — in every query,
every migration and every psql session, forever. The real choice is `snake_case`
or permanent quoting, which is not a trade-off.

Drizzle keeps the TypeScript side camel-case: `createdAt: timestamp('created_at')`.

### Tables are plural

`users`, `orders`, `order_items`. **Rejected: singular.**

The formal argument favours singular — a table is a relation describing one kind
of thing — and the practical argument for it is real: no pluralising, so no
`person`/`people`, no `status`/`statuses`, and one word shared with the
TypeScript type.

It loses on a hard fact. `user`, `order` and `group` are **reserved words** in
SQL, and reserved words cannot be identifiers without double-quoting.
`CREATE TABLE user (…)` is a syntax error; `CREATE TABLE "user" (…)` works and
commits every future reference to quoting it. Those three are among the most
commonly needed tables in any application, so singular is not really a convention
— it is a convention plus an exception list covering its most frequent cases.

`users`, `orders` and `groups` collide with nothing.

Riders: join tables take both nouns, both plural (`order_items`,
`role_permissions`). The TypeScript type stays singular —
`type User = typeof users.$inferSelect` — which is Drizzle's own idiom and keeps
`User` the name used in service code.

### Constraints, indexes and triggers are named explicitly, with a type prefix

| prefix | object | example |
|---|---|---|
| `pk_` | composite primary key | `pk_order_items` |
| `uq_` | unique constraint | `uq_users_email` |
| `fk_` | foreign key | `fk_orders_user_id` |
| `ck_` | check constraint | `ck_orders_amount_positive` |
| `idx_` | index | `idx_orders_user_id_created_at` |
| `trg_` | trigger | `trg_users_updated_at` |

**Rejected: PostgreSQL's own suffix style** (`users_email_key`,
`orders_user_id_fkey`), and rejected more strongly, *not naming them at all*.

These names are not cosmetic. When a constraint is violated the driver hands the
application a structured error whose only machine-readable description of *which
rule broke* is `error.constraint` — a string, the constraint's name.
`src/database/driver-error.ts` maps that to an HTTP status and, where
appropriate, to a field-level message, and it does so without letting the raw
driver error reach the client, since the raw text carries the table layout and,
in its `DETAIL` line, another row's data.

So constraint names are an interface consumed by application code, closer to an
API route than to a variable name. Prefixes win because the name almost always
appears alone — in an error string, a log line, a `pg_constraint` query — where
`uq_users_email` says what broke in two characters and `users_email_key` requires
knowing that `_key` means unique while `_fkey` means foreign key.

Not naming them at all fails hardest on check constraints, where PostgreSQL
generates `users_check`, `users_check1`, `users_check2` — a positional counter
that describes nothing and shifts when a migration adds another.

Three riders:

- **Check constraints are named for the rule, not the column.**
  `ck_orders_amount_positive`, not `ck_orders_amount`. One column can carry
  several checks, and the name is the only description of the rule that survives
  into the error.
- **Single-column primary keys keep PostgreSQL's `<table>_pkey`.** The one
  documented exception. A table has exactly one primary key, so the name carries
  nothing the table name does not, and forcing `pk_users` means declaring the key
  in table-level config rather than on the column. Composite keys are declared at
  table level anyway, so they get `pk_`.
- **Name them even where the generated name would have been fine.** A generated
  name is not a promise — it comes from the library's naming logic, and a version
  bump that changed it would silently break the driver-error mapping. An
  explicit name changes only when someone edits it.

**Identifiers are limited to 63 bytes and are silently truncated past that.** A
truncated name still works and no longer says what was written, which is why the
prefixes are terse (`uq_`, not `unique_`) and why only the distinguishing columns
belong in the name.

---

## 2. The columns every table starts with

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // …the columns that actually differ
});
```

`uuidv7()` is built into PostgreSQL 18, which is why decision 1 chose 18 over 17.
The primary key is also the id the API exposes — decision 4; there is no second
public identifier.

**No shared column helper is provided, deliberately.** Factoring this into an
`id()` builder and a `timestamps` object is the obvious next step and should
happen — but not before a call site exists. A helper with no table to build
proves nothing: `tsc` confirms the builder chain type-checks, which says almost
nothing about the SQL it emits. Whether the `uuidv7()` default renders as
`DEFAULT uuidv7()`, whether the column comes out `created_at`, whether
`defaultNow()` yields `now()` — none of it is observable until `drizzle-kit
generate` runs against a real table and someone reads the output. Extract the
helper when there are two tables to check it against.

---

## 3. Timestamps

### Every timestamp is `timestamptz`

**Rejected: `timestamp`** (`timestamp without time zone`).

Neither type stores a time zone; the names mislead. `timestamp` stores a
*calendar reading* — "2026-08-26 14:30:00", with no anchor to any actual moment,
which is what a wall clock says and what two wall clocks in different places say
differently at the same instant. `timestamptz` stores an *absolute instant*,
internally UTC, converting on input from whatever offset it was given and on
output to the session's zone. The original zone is not retained.

The difference is semantic: `timestamp` answers "what did the clock read",
`timestamptz` answers "when did this happen". Anything recording an event wants
the second, because only the second can be compared, sorted or subtracted across
users in different places. Getting it wrong fails quietly — values from different
regions compare as though on one clock, and an hour of readings occurs twice
during a daylight-saving fall-back with no way to distinguish them.

### The session time zone is pinned to UTC by the application

`src/database/database.module.ts` sets `options: '-c timezone=UTC'` on the pool.

Reads through the driver are correct regardless, since `timestamptz` renders with
an explicit offset that `node-postgres` parses into a correct `Date`. What the
session zone decides is **`date_trunc` and `EXTRACT`, which operate on a
`timestamptz` in the session's zone**. `date_trunc('day', created_at)` therefore
has no single answer — its day boundary moves with the server's configured
offset, so a daily report is right on a machine set to UTC and quietly wrong on
one that is not.

The reach of this is limited to the application's connections. **`drizzle-kit`
and psql connect with the raw DSN and do not get it.** For DDL that is
irrelevant; a data-backfill migration using `date_trunc` would run in the
server's zone. The fix, if it ever matters, is `options=-c timezone=UTC` in the
migration DSN — the same mechanism `docs/migrations.md` describes for
`lock_timeout`.

### `updated_at` is maintained by a trigger

**Rejected: the application setting it**, whether by hand or through Drizzle's
`$onUpdate()`.

Every table with an `updated_at` column attaches this, once, in its migration:

```sql
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
```

The function `set_updated_at()` already exists — it is created by
`drizzle/20260901154040_set_updated_at.sql` and is the first entry in the
escape-hatch register in `docs/database-decisions.md`. It references no table, so
one function serves the whole database.

Application-maintained loses on two counts. It **only holds for writes that went
through the application**: a data-fix migration, a psql session, a background job
on raw SQL and any second service all leave the column stale — and unusual writes
are exactly the ones anyone reading `updated_at` is trying to reconstruct. And it
takes the timestamp from **Node**, so with several instances the column carries
several independently drifting clocks; two rows written a millisecond apart on
different instances can be ordered wrongly, which silently breaks "give me
everything changed since X".

Two details the statement above is carrying:

- **`WHEN (OLD.* IS DISTINCT FROM NEW.*)`** is what stops a no-op update
  (`SET name = name`) from bumping the timestamp. Without it the column records
  "something wrote to this row" rather than "this row changed".
- **`now()` is transaction start time**, not wall clock at that instant, so every
  row touched by one transaction carries an identical `updated_at`. A multi-row
  update reads back as the single event it was.

The cost, accepted: a trigger is invisible from `schema.ts`, and someone reading
the TypeScript will reasonably assume the application maintains the column. The
register and this section are the whole of the mitigation, and they work only
while they are kept current. Attaching this trigger to a table with no
`updated_at` column succeeds at `CREATE TRIGGER` and fails on the first
`UPDATE` — loud and immediate, but later than expected.

---

## 4. Nullability

**Columns are `NOT NULL`. Nullable is the case that needs a reason**, stated in
the migration.

`NULL` means *unknown*, and it propagates: comparisons against it are neither
true nor false, so a row can silently drop out of a `WHERE` clause that looks
like it should match. Making nullable the exception keeps "unknown" out of
columns that are only nullable because nobody thought about it.

---

## 5. Fixed sets of values

**Choice: `text` with a `CHECK` constraint, with the allowed values exported once
as an `as const` array and used to build both the TypeScript type and the
constraint.**

**Rejected: a native PostgreSQL `enum` type; a lookup table as the default.**

A native enum is attractive — 4-byte storage, sorting in declaration order, and
`pgEnum` gives the database type and the TypeScript union from one declaration.
It is rejected on how it changes:

- **A value cannot be removed.** There is no `DROP VALUE`. Removal means creating
  a replacement type, altering every column that uses it, and dropping the old.
- **`ALTER TYPE … ADD VALUE` may run inside a transaction, but the new value
  cannot be used until that transaction commits** — and a known cost of decision
  2 is that **`drizzle-orm` wraps every pending migration in a single
  transaction**. So the ordinary two-step sequence (one migration adds the value,
  a later one backfills rows to it) works against a database where the first
  already ran, and **fails from empty**, where both are pending in one
  transaction. The result is a migration set that applies to production and
  cannot be applied to a fresh database — which breaks the property that the
  migration set must apply cleanly from empty, in the direction hardest to
  notice, since the environment that fails is the disposable one.

Check-constrained text changes with plain DDL and no transaction restriction.
Adding a constraint normally scans the table under a strong lock, but that is the
hazard `docs/migrations.md` already answers with `NOT VALID` followed by
`VALIDATE CONSTRAINT`.

Its own cost, stated so it is not discovered: **the value list appears twice** —
once in Drizzle's `text('status', { enum: [...] })`, which affects only the
TypeScript type and emits no constraint, and once in the check constraint SQL.
Both must be built from one exported array:

```ts
export const ORDER_STATUS = ['pending', 'paid', 'shipped'] as const;
```

and the constraint must end up equivalent to:

```sql
CONSTRAINT ck_orders_status CHECK (status IN ('pending', 'paid', 'shipped'))
```

The exact Drizzle expression that generates that SQL is left to the first table
to establish, and should be checked against the generated migration rather than
assumed — for the same reason no column helper ships here.

**A lookup table with a foreign key is the documented exception**, for sets that
carry metadata beyond the code (a display label, a sort order, a translation key)
or that grow without a code change. Its cost is that the values become runtime
data, so TypeScript knows nothing about them and the union gets hardcoded
anyway — two sources of truth, which is why it is the exception rather than the
rule.

**Native enums are disfavoured, not banned.** Anything reaching for one records
why, and proves the migration set still applies from empty.

---

## 6. Foreign keys

**Foreign keys are always present, and `onDelete` is always declared
explicitly — including when it is the default.**

Without one, deleting a parent leaves orphan children, and the damage is quiet:
an inner join silently drops those rows so a report undercounts, a left join
produces nulls in columns the code assumed were populated. Nothing errors.

The systems that drop foreign keys do so because they have sharded across
machines where the constraint cannot be checked, or because the per-row lock on
the referenced parent matters at their write volume. Neither applies here, and
the alternative — enforcing referential integrity in application code — holds
only for writes that went through the application.

### The `ON DELETE` choice

The test is whether the child **is part of** the parent or merely **refers to**
it.

| relation | behaviour | example |
|---|---|---|
| composition — child has no independent existence | `cascade` | `order_items` → `orders` |
| association — child refers to an independent thing | `no action` | `orders` → `users` |
| optional reference whose loss is tolerable | `set null` | `posts.author_id` |

**The default is `no action`. Rejected: `restrict`.** They behave identically in
normal use — both refuse the delete — but **`restrict` can never be deferred,
while `no action` can**, if the constraint is later declared `DEFERRABLE`.
Deferral is what lets a transaction pass through a temporarily invalid state
(reordering rows under a unique constraint, resolving a circular reference), and
converting `restrict` to deferrable later means dropping and recreating the
constraint under a lock and a table scan.

The cost of `no action` is that it **reads wrong** — it sounds like "no
enforcement" and is skimmed that way. It means *refuse the delete*. Say so in a
comment at the declaration.

`cascade` is chosen deliberately and never inherited, because it is unbounded and
invisible: one `DELETE` removes an amount of data nobody can see from the
statement, and it keeps working right up until a fourth table joins the chain.
`set null` requires a nullable column and therefore needs a reason twice over.

Declaring `onDelete` even when it matches the default is the same argument as
naming constraints: an absent clause is ambiguous between "chose the default" and
"never thought about it", and only one of those survives review.

### Two riders

- **Foreign key columns get an index.** This is the one standing exception to
  §11. PostgreSQL indexes the referenced side, because it is already a key, but
  **not the referencing column** — so a parent delete scans the whole child table
  looking for references. The query that needs the index is the delete, which
  PostgreSQL issues implicitly.
- **`ON UPDATE` is not a decision.** Decision 4's UUIDv7 primary keys are
  immutable, so the update path never fires. Leave it at the default.

---

## 7. What the database enforces, and what it cannot

**Choice: declarative constraints only — `CHECK`, `UNIQUE`, `EXCLUDE`, foreign
keys. A trigger may set a value on the row being written; it may not make a
decision that depends on reading other rows.**

**Rejected: triggers as a general enforcement mechanism.**

An invariant the database *can* enforce, it does. Enforcing in application code
alone is the case that needs a reason, because it holds only for writes that went
through the application. But that principle has a hard edge, and this section
exists so it does not get applied to something that cannot carry it.

### What is available, by shape of invariant

- **Single row** — `CHECK`. `amount > 0`, `starts_at < ends_at`. Complete and
  cheap. Its limit: a `CHECK` can only see the row it is checking. No subqueries,
  no other tables, no other rows; PostgreSQL refuses to create one that tries.
  The workaround of calling a function that queries is not reliably enforced —
  see below — and is a well-known way to build something that looks like a
  constraint and is not.
- **Cross-row in one table** — `UNIQUE` for equality; **`EXCLUDE` for everything
  else**, which is underused and worth naming explicitly:
  `EXCLUDE USING gist (room_id WITH =, during WITH &&)` makes overlapping
  bookings impossible, declaratively and correctly under concurrency. Needs the
  `btree_gist` extension to mix `=` with a range operator.
- **Cross-table** — foreign keys, and nothing more expressive.
- **Aggregate** — "balance never negative", "at most three occupants", "exactly
  one primary address". **PostgreSQL has no declarative mechanism for these.**

### Why a trigger does not fill the fourth gap

The obvious move — count the rows, raise an exception — works in testing and is
not safe. Under the default isolation level each transaction sees a snapshot that
excludes other transactions' uncommitted rows:

- Room holds 3; two occupants exist.
- Transaction A inserts. Its trigger counts 2 and allows it.
- Transaction B inserts concurrently. Its trigger also counts 2 — A's row is
  uncommitted and invisible — and allows it.
- Both commit. The room holds 4.

No error, nothing in the logs, and it fails only under concurrency, which means
it passes every test a person writes. It is worse than no check, because the
check's existence is why nobody handled the case in the application.

Making it safe requires explicit locking or `SERIALIZABLE` with retry — which is
§10, the application's concurrency strategy. The trigger is not doing the work;
the locking is.

### So, the fallbacks

Where an aggregate invariant matters, either **restructure it into a declarative
one** — materialise the aggregate onto the parent row and put a `CHECK` on that,
which makes the invariant single-row and the concurrency problem the parent row's
lock, a solved and visible thing — or **enforce it in the application with a
stated locking strategy** from §10. Both are correct. A trigger that reads other
rows is neither, while looking like both.

**A database constraint does not excuse validation at the edge.** A `CHECK`
violation reaches the user as a 422 from the driver-error mapping, which is
correct but a poorer experience than a zod schema rejecting the value with a
field-level message. The constraint is the backstop that holds for every writer;
the zod schema is the one that gives a good error. Both, not either.

---

## 8. Soft delete

**Choice: opt-in per table, with the reason stated in the migration that adds
it.**

**Rejected: blanket soft delete on every table; and banning it outright.**

The rule exists so that nobody adds `deleted_at` out of habit. It buys real
things — per-row recovery without the full restore that decision 6 otherwise
leaves as the only path, history that survives, and no orphaning — and it is
right for tables where restoration is a genuine product requirement.

It is not the default because **its cost is not paid where it is added**. It is
paid at every query against that table, forever, by people who were not there:

- **Every read must filter `deleted_at IS NULL`, and forgetting is silent.**
  Deleted rows appear in lists, closed accounts authenticate, cancelled orders
  land in totals. The database cannot help — `deleted_at` is an ordinary column.
- **Unique constraints stop meaning what they say.** A soft-deleted user still
  occupies `uq_users_email`, so that address can never be used again by anyone.
  The fix is a **partial unique index**, and any soft-deleted table must apply it
  to every unique constraint it has:
  ```sql
  CREATE UNIQUE INDEX uq_users_email ON users (email) WHERE deleted_at IS NULL;
  ```
- **Foreign keys can no longer enforce what is meant.** A foreign key enforces
  "this user exists", not "this user exists and is not deleted" — the deleted row
  still satisfies it. Preventing a new order against a deleted user becomes
  application logic, which is the exact reversal of §7's principle. That is
  acceptable as a decision and unacceptable as a side effect.
- **Rows accumulate without bound**, in the table and in every index on it. The
  eventual fix is hard-deleting old soft-deleted rows on a schedule, which
  reintroduces hard deletes anyway.
- **Erasure obligations are not satisfied by a flag.** Where a user has a right
  to deletion, `deleted_at = now()` does not deliver it, so a genuine hard-delete
  or anonymisation path is needed regardless.
- **It does not cascade.** A hard delete takes an order's items automatically; a
  soft delete leaves them live, and marking them is application code that must
  remember every child table.

Where a table does opt in, the filter applies to **every statement touching the
table, not only reads** — an update that omits it edits a deleted row just as
silently as a select returns one. Where that can be enforced rather than
remembered, and how, is *The two rules no constraint can enforce* below.

---

## 9. Idempotency

**Choice: an operation a caller may retry carries an `idempotency_key` column on
the table being written, under a unique constraint scoped to the principal the
write is performed for — `UNIQUE (owner_id, idempotency_key)`.**

**Rejected: an unscoped single-column constraint, because a replayable key is a
credential; and a dedicated `idempotency_keys` table as the universal mechanism —
kept as the documented escape.**

A client sends `POST /orders`, the server creates it, and the response is lost.
The client now knows nothing: retrying may create a second order, not retrying
may lose the first. This is not fixable at the transport layer — exactly-once
delivery over an unreliable channel is a known impossibility, not an engineering
gap. What is achievable is making the operation safe to apply twice.

The client generates a key per logical operation and reuses it on retry. **The
unique constraint is the mechanism, and that matters**: checking "have I seen
this key?" in application code and then inserting is a read-then-write race that
two concurrent retries both win. The constraint is checked atomically and cannot
be raced.

### The name is `idempotency_key`, and it is not the request id

This codebase already has `X-Request-Id` (`src/http/request-id.ts`), and the two
have opposite semantics:

| | `X-Request-Id` | `idempotency_key` |
|---|---|---|
| identifies | one HTTP attempt | one logical operation |
| on retry | a *different* value | the *same* value |
| if absent | server mints one | request is rejected |
| if malformed | ignored, request proceeds | request is rejected |

`request-id.ts` is explicit that a bad correlation id is not worth failing a
request over. An idempotency key silently ignored is worse than none, because the
caller believes the write is protected. The distinction is noted in that file
too, so it is visible from the side someone would be standing on.

### Shape

Default: a column on the created table, with the unique constraint **scoped to the
principal the write is performed on behalf of** —
`UNIQUE (owner_id, idempotency_key)`. It is atomic by construction — key and row
are inserted in one statement, with no window where one exists without the other —
and needs no retention job, since the key lives and dies with its row. The key
column stays nullable and a scoped index keeps that working: PostgreSQL treats any
row with a NULL in the index as distinct from every other, so one owner may hold
any number of rows created without a key. Verified against PostgreSQL 18, together
with the two outcomes the scope exists to separate — the same key twice for one
owner is rejected, the same key across two owners is not.

**The scope is not optional, and this corrects what this section used to say.** It
claimed a single-column constraint sufficed because client-generated UUIDs do not
collide. That is an argument about *accidental* collision, and it was being used to
answer a question about *authorization*, which it cannot. Read it together with the
replay rule below — a repeated key returns the original response — and an unscoped
key is a credential: whoever presents it is handed the row it created. Keys are not
secrets. They ride in request bodies through proxies, into client logs and into
SDKs; and a client that derives its key from a hash of the payload, which is a
reasonable implementation and a common one, makes two callers submitting the same
logical request collide *by design*.

The scoping column therefore arrives in the **same migration** as the key.
Retrofitting it later means dropping and rebuilding the unique index under a lock,
after first deciding what to do about the keys that already collide across owners —
and decision 6 in `docs/database-decisions.md` leaves a forward fix as the only
route.

**Where there is no principal to scope to**, there is nothing to scope by, and the
replay rule below does not apply: a repeated key is a `409` and never a replayed
body. That covers an endpoint genuinely open to anonymous callers, and it covers
this skeleton as it stands, which has no authentication at all. Handing a stored
response to a caller you cannot identify is the same leak with an extra step.

The **dedicated table is the escape** for operations spanning several tables or
that create no row. It is a real subsystem — stored response bodies, a retention
policy, a status for the in-flight case — and whoever needs it first builds it.

Two things for the repository layer, noted here because they are consequences of
this shape:

- **Concurrent retries.** One wins the constraint; the other gets a unique
  violation while the winner's transaction has not yet committed, so the original
  result is not visible to it. The honest response is `409` meaning *in progress,
  retry shortly*, not a replayed result. The alternative is a null dereference on
  a path that only executes under concurrency.
- **`uq_*_idempotency_key` must not map to the same outcome as other unique
  violations.** For every other constraint a unique violation is a `409` error.
  For this one it is the retry working correctly, and it should produce the
  original response — but **only where the constraint is scoped and the caller
  presenting the key is the principal it is scoped to**. Unscoped, or with no
  principal to check against, it is a `409` with no body. Telling this constraint
  from the others is possible only by its name, which is the second place §1's
  naming convention turns out to be load-bearing.

---

## 10. Concurrency control

**Choice: optimistic concurrency, with a `version` column.** Recorded as decision
7 in `docs/database-decisions.md`.

**Rejected: pessimistic row locks as the default; `SERIALIZABLE` as the default.
Both are kept as named exceptions.**

### The problem, and the thing that does not solve it

Two requests read the same row, both write, and the second overwrites the first
with no error anywhere.

"Wrap it in a transaction" does not help. PostgreSQL's default isolation level is
**Read Committed**: each statement sees rows committed before that statement
began. That prevents reading uncommitted garbage. It does not guarantee that what
was read is still true when the write happens. A single statement like
`UPDATE products SET stock = stock - 1` is safe, because the row is re-read under
lock — the danger is **read-modify-write split across statements**, which is what
happens the moment the modify step involves application logic.

### The rule

A row that can be concurrently modified carries
`version integer NOT NULL DEFAULT 0`, and every update is conditional:

```sql
UPDATE products SET price = 120, version = version + 1
WHERE id = $1 AND version = $2;
```

Zero rows updated means the read was stale — a `409 Conflict` carrying the
current state, and the caller re-reads.

The deciding argument is the shape of the traffic. This is an HTTP service, and
its dominant mutation pattern is *read in one request, write in a later one*.
Neither row locks nor `SERIALIZABLE` can express that — there is no transaction
spanning a user thinking for ten minutes. Optimistic is the only one of the three
that works when a human sits between the read and the write. It also fails
visibly: zero rows updated is unambiguous, and `409` is an honest answer, where
the alternative failure is discarding a write and hearing about it from a
customer.

**Not every table needs it.** A table gets `version` if its rows are modified
through a read-modify-write flow reachable by more than one writer. Append-only
tables, reference data and rows with a single owner do not have the problem, and
adding the column out of habit is the same failure §8 warns about.

### The two exceptions

**`SELECT … FOR UPDATE`** where the whole read-modify-write is inside one
transaction, contention is real, and failing is unacceptable — inventory
decrements, balance transfers. It requires a **deterministic lock ordering**:
always acquire in ascending primary key order, and fix an order between tables.
Without it, A locking row 1 then 2 while B locks 2 then 1 deadlocks; PostgreSQL
detects it after roughly a second and kills one with `40P01`.

Note a local consequence: `statement_timeout` is already set on the pool and
counts time spent waiting for a lock, so a blocked `FOR UPDATE` is cancelled as a
query timeout rather than hanging. Better than hanging, but the bound comes from
a value chosen for query duration, not for contention.

**`SERIALIZABLE` with bounded retry on `40001`** for invariants spanning rows
that no constraint can express — the honest fallback §7 promised. Serialization
failures are expected operation, not errors. Its condition: every transaction
must be safe to run twice, so side effects that are not — charging a card,
sending mail — sit outside the transaction or are idempotent themselves.

### What this costs

- **Every update must carry the version predicate, and forgetting is silent.** An
  `UPDATE` without `AND version = $2` succeeds and clobbers. No database
  mechanism can require a `WHERE` clause. See below.
- **It pushes work onto the client.** A `409` means re-read and decide, possibly
  asking a human. That is an API contract obligation from the first endpoint, not
  a server-side detail to retrofit.
- **It protects one row and nothing else.** A version column says nothing about
  invariants across rows or tables; reaching for it there gives false confidence,
  which is why the two exceptions are written above rather than left to be
  rediscovered.

---

## 11. Indexes

**An index arrives with the query that needs it, and the query goes in the commit
message.**

An index makes one read shape fast and every write on that table slower, and
carries every dead row until vacuum reclaims it. Requiring the justifying query
is what stops indexes accumulating that nobody can later prove are needed — and
nobody removes an index they cannot prove is unused.

Two things to know when writing one:

- **The one standing exception is foreign key columns** (§6), whose query is the
  implicit scan PostgreSQL performs on a parent delete.
- **`CREATE INDEX CONCURRENTLY` is unavailable inside a migration here.** The
  migrator wraps every pending migration in one transaction and PostgreSQL
  refuses `CONCURRENTLY` inside a transaction block. On a large live table this
  means a plain `CREATE INDEX` holding a write lock for the duration; see the
  lock hazards in `docs/migrations.md`.

---

## The two rules no *constraint* can enforce

Two rules in this file have no constraint standing behind them. Collected here so
that neither is discovered as a bug:

1. **The soft-delete filter** (§8). A read that forgets `deleted_at IS NULL`
   returns deleted rows, successfully. **An update that forgets it edits a deleted
   row**, equally successfully — this applies to every statement touching the
   table, not only to reads.
2. **The version predicate** (§10). An update that forgets `AND version = $2`
   clobbers a concurrent write, successfully.

Both are silent, and both are individually easy to get right and collectively
certain to be got wrong.

### This section used to claim more than it could

It was headed *"The two rules the database cannot enforce"*, and said a repository
was "the only thing that makes either rule real". **Both statements were too
strong, and the second is the one that mattered** — it closed off a mechanism this
document prefers everywhere else. §7 says that an invariant the database *can*
enforce, it does, and that enforcing in application code alone is the case
needing a reason. These two rules were exempted from that principle without ever
being tested against it.

What is actually available, in descending order of strength:

**The soft-delete filter is enforceable — by a view.** For a soft-deleted table,
expose the live rows as a view and grant the runtime role the view rather than the
table:

```sql
CREATE VIEW notes_live AS SELECT * FROM notes WHERE deleted_at IS NULL;
-- and, so that writes cannot push a row out of the view's own condition:
--   CREATE VIEW … WITH CHECK OPTION
```

A single-table view with no aggregation is **auto-updatable** in PostgreSQL, so
`INSERT`, `UPDATE` and `DELETE` go through it; `WITH CHECK OPTION` rejects a write
whose result would fall outside the condition. Forgetting the filter then stops
being possible rather than being conventionally located, which is a different
class of guarantee. The soft delete itself — setting `deleted_at` — is the one
operation that needs the base table, and that is a narrow, named exception instead
of a blanket one.

Its costs, which is why this is offered rather than mandated: the view is created
in a migration and is therefore invisible to `drizzle-kit`'s snapshot, so it joins
the escape-hatch register in `docs/database-decisions.md`; Drizzle needs the view
declared (`pgView`) alongside the table, so the schema carries both; and the grant
split it depends on is part of the runtime-role work that is **not yet built**
(decision 1). Until those grants exist, the view is a convention like any other —
strictly better than nothing, and not yet enforcement.

**The version predicate is partly enforceable — by a guard trigger.** A
`BEFORE UPDATE` trigger raising unless `NEW.version = OLD.version + 1` catches
every update that forgot to bump the column, which is the common form of the
mistake. It stays inside §7's rule, because it reads only `OLD` and `NEW` and
decides nothing from other rows. What it cannot catch is an update that bumps the
version *and* omits the `WHERE version = $2` — so it narrows the gap rather than
closing it, and the predicate remains the repository's job.

**So the honest statement is:** a repository is where these two rules are applied
today, and for the version predicate it is the only place that can apply them
fully. It is not the only mechanism available, and anything that calls it the only
one is overstating the case. `docs/database-decisions.md` decision 8 decided in
favour of the boundary for reasons that survive this correction — a repository is
also where both rules live *together*, and a view cannot be the answer for a table
with no soft delete.

One thing to be exact about, because the decision and the code arrived at
different times. That decision recorded the boundary and built no repository,
there being no table to build one for — so today these two rules are enforced by
nothing at all. What changed is that the place they will be enforced is now
settled rather than open. **The first repository this project writes is where
they become real**, and it is the reviewer's job on that commit to check they
were applied. `docs/adding-a-feature.md` §3.4 states that obligation as a rule a
repository is held to, and its §11 is the checklist the reviewer works from.

---

## Summary

| # | Rule | Beat |
|---|---|---|
| 1 | `snake_case`; tables plural; `pk_`/`uq_`/`fk_`/`ck_`/`idx_`/`trg_` prefixes, named explicitly | singular tables (reserved words); PostgreSQL suffix style; generated names |
| 2 | UUIDv7 `id`, `created_at`, `updated_at` on every table; no shared helper yet | shipping a helper with no call site to verify it |
| 3 | `timestamptz` everywhere, session pinned to UTC, `updated_at` by trigger | `timestamp`; application-maintained `updated_at` |
| 4 | `NOT NULL` by default | nullable by default |
| 5 | `text` + `CHECK` from one `as const` array | native enum (fails from empty under one transaction); lookup table as default |
| 6 | Foreign keys always, `onDelete` always explicit, default `no action` | omitting the clause; `restrict` (never deferrable) |
| 7 | Declarative constraints only; triggers set values, never decide | enforcement triggers (unsafe under concurrency) |
| 8 | Soft delete opt-in per table, reason in the migration | blanket soft delete; banning it |
| 9 | `idempotency_key` unique **scoped to the caller**; dedicated table as escape | an unscoped key (a replayable key is a credential); mandatory `idempotency_keys` table |
| 10 | Optimistic `version`; `FOR UPDATE` and `SERIALIZABLE`+retry as exceptions | pessimistic default; serializable default |
| 11 | Indexes arrive with their query; foreign key columns excepted | indexing ahead of a query |
