# Adding a feature

How one API resource is built in this project, in what order, and the rules each
layer is held to.

The three existing documents decide what the *database* looks like. This one
decides what a *feature* looks like: the files, their boundaries, the request and
response contracts, and what every endpoint owes an answer for when a write goes
wrong. It exists for the same reason they do — a rule that is never decided gets
decided differently in each of the first five features, and then the project has
no pattern, only history.

**The audience is whoever adds the first endpoint to a project cloned from this
skeleton, and everyone who adds the tenth.** Because every project starts from
the same commit, a convention settled here is shared by all of them; one invented
in a feature branch is shared by nobody.

**No feature ships here.** This repository has no domain, so the worked example in
§10 is the specification for the first slice rather than a description of code you
can open. Where something must be confirmed against a compiler or a generated
migration rather than trusted from this page, it says so.

Read `docs/database-decisions.md` first if you have not — §8 there decided the
repository boundary this document is mostly the practical half of. Then
`docs/schema-conventions.md` §§2, 8, 9, 10, which are the four the repository is
responsible for. `docs/migrations.md` is the runbook for step 3.

---

## 0. What the first feature pays for

Four things the skeleton deliberately does not ship, which the first feature has
to build and every later one inherits. They are listed first so they are budgeted
rather than discovered.

**1. A Drizzle instance.** `DatabaseModule` exports `POOL` — a raw `pg` pool —
and `drizzle-orm` is in `dependencies` while being imported nowhere. The first
feature adds a `DB` provider over that same pool (§7). Note what this does *not*
cost: `installQueryLogging` wraps `client.query`, and Drizzle's node-postgres
driver issues everything through the client it checks out, so query logging,
`reqId` correlation and slow-query warnings keep working through Drizzle with no
further wiring.

**2. The `Executor` type and the transaction rule.** Decision 8 settled that
transactions are explicit parameters and built nothing. §7 of this document is
that shape, written out — including why the executor parameter is required rather
than defaulted, which is the difference between a forgotten `tx` being a compile
error and being a partial write nobody sees.

**3. Test isolation.** Settled by the first feature (email sign-in) as **decision 9
in `docs/database-decisions.md`**: truncate the tables a spec touches before each
test, and run jest `--runInBand`. `src/database/testing.ts` opens the app's own
pool for a repository spec. §9 has the rule.

**4. Authorization.** Settled by the guard + `GET /me` slice: a global
`AuthGuard` requires an access token on every route that is not `@Public()`, and
the caller reaches services as an argument. §3.6 has the rules.

---

## 1. The shape of a feature

One directory under `src/`, named for the resource in plural kebab-case — the same
word as the URL segment and the table, so the three never have to be mapped onto
each other.

```
src/notes/
  notes.module.ts         wiring only; no logic
  notes.controller.ts     HTTP in, HTTP out
  notes.service.ts        business rules, transaction boundaries
  notes.repository.ts     all SQL for this resource
  notes.mapper.ts         row -> response object
  dto/
    create-note.dto.ts
    update-note.dto.ts
    list-notes.dto.ts     query parameters
    note-id.dto.ts        path parameters
  notes.service.spec.ts   unit, fake repository
  notes.repository.spec.ts  integration, real Postgres
test/
  notes.e2e-spec.ts       the wire contract
```

Six files before a line of business logic is a fair objection, and the answer is
that five of them are the boundaries §3 exists to keep. A feature that starts as
controller-plus-service acquires the other layers later by having them extracted
under pressure, which is when the soft-delete filter gets left in two places.

### The table does not live here

**Choice: every table stays in `src/database/schema.ts`.**

**Rejected: a `notes.schema.ts` inside the feature directory.**

Cohesion argues for the feature directory and loses on three counts, all
mechanical. `drizzle.config.ts` resolves one `schema` path and diffs one
snapshot, so the schema is a single global object whatever the file layout.
Foreign keys make tables import each other, and two feature modules owning tables
that reference each other is an import cycle between features rather than a
dependency on a shared leaf. And `docs/database-decisions.md`'s escape-hatch
register, the `_journal.json` ordering hazard and the migration set are all
global already — splitting the one file that describes them buys nothing and
costs the ability to read the schema in one pass.

**The growth path, so it is not improvised:** when one file becomes unpleasant,
`src/database/schema.ts` becomes `src/database/schema/`, one file per table plus
an `index.ts` that re-exports them, and `drizzle.config.ts`'s `schema` becomes
`./src/database/schema/index.ts`. The snapshot is unaffected — it is keyed on
table names, not file paths. Do that as a commit of its own, never inside a
feature commit.

---

## 2. The order of work

The order is not arbitrary. Each step produces the thing the next one is checked
against, and doing them out of order is how a URL ends up shaped by a table.

**1. Name the resource and write down its URLs.** Method, path, status code and
error codes for every operation, before any code. This is the only artefact in
the list that **cannot be changed later** — `DEFAULT_VERSION` exists in
`configure-app.ts` precisely because a URL is a client contract — so it is worth
ten minutes and a second opinion. §4.4 and §5.3 are the conventions it must
satisfy.

**2. Model the table** in `src/database/schema.ts`, against
`docs/schema-conventions.md`. Decide explicitly — and record the reason in the
migration — whether this table carries `version` (§10 there), `deleted_at` (§8)
and `idempotency_key` (§9). Defaulting to all three is as wrong as defaulting to
none.

**3. Generate and read the migration.** `npm run db:migrate:create`, then open
what it wrote; `docs/migrations.md` is explicit that this is a review step.
Anything the DSL cannot express — the `updated_at` trigger, a partial unique
index, a check constraint — is hand-written into that file, and anything created
that way is added to the escape-hatch register in `docs/database-decisions.md` in
the same commit. Apply with `npm run db:migrate`, then confirm it actually ran:
the tool reports success either way.

**4. Write the DTOs** (§4). They are the only description of the request, and
writing them before the repository stops the request shape being dictated by the
row shape.

**5. Write the repository** (§3.4). It is the layer the two rules with no
constraint behind them live in, so it is the one to get right while attention is
fresh.

**6. Write its integration test** (§9). Before the service, because a repository
is the one layer whose correctness is not visible by reading it — a Drizzle
builder chain that type-checks says almost nothing about the SQL it emits, which
is the same argument `docs/schema-conventions.md` §2 makes for not shipping a
column helper.

**7. Write the service** (§3.3), then **8. the controller** (§3.2), then **9. the
module**, registered in `src/app.module.ts`'s `imports`.

**10. Write the e2e** (§9) and **11. update the docs** — the escape-hatch
register if step 3 used it, and `docs/database-decisions.md` decision 9 if you
are the first feature.

**If you are the first feature, also delete the stub.** `src/app.controller.ts`
and `src/app.service.ts` are the `nest new` Hello World answering `GET /api/v1`,
and `test/app.e2e-spec.ts` asserts it — which means the only endpoint this
repository tests is one no product wants. It exists so the skeleton has something
to prove the envelope and the request id against; the moment a real endpoint does
that, it is a permanent fake route in every cloned project. Delete both, delete
`src/app.controller.spec.ts`, drop them from `app.module.ts`, and repoint the e2e
at your resource — keeping its assertions on the literal path, the status, the
envelope and `X-Request-Id`, which are what that spec is actually for.

---

## 3. Layer rules

### 3.1 The boundary

| | may import | must never contain |
|---|---|---|
| **controller** | its DTOs, its service, `@nestjs/common` | SQL, Drizzle, `POOL`, `DB`, business rules, `{ data }` |
| **service** | its repository, other services, DTO *types* | SQL, Drizzle, `POOL`, `DB`, `Request`, `Response`, `res.status` |
| **repository** | `DB`, `schema`, Drizzle operators | `HttpException` or any subclass, `Request`, business rules |
| **mapper** | the row type, the response interface | anything injectable |

**Two of these are enforced by ESLint rather than by review.** `eslint.config.mjs`
restricts `drizzle-orm` and `pg` imports outside `*.repository.ts` (plus
`src/database/` and `src/health/`, which legitimately hold the pool), and restricts
Nest's HTTP exception classes *inside* `*.repository.ts`. That follows the
precedent the same file already set for `process.env`: a boundary worth writing
down is worth a rule, because the alternative is catching it in review every time
forever. The rest of this table is still prose.

The two entries that get violated first, and what they cost:

**The repository never throws an `HttpException`.** It is tempting —
`NotFoundException` is right there and the repository is the layer that knows the
row is absent. It loses because a repository is also called from background jobs,
from other services and from a second endpoint that wants a different answer for
the same absence (a `PUT` that upserts does not want a 404), and a layer that has
already chosen the status code cannot serve them. So **the repository returns
outcomes as values** — `null`, or a small union — and the service decides what
each one means over HTTP. §6.3 is the table of which value maps to which status.

**The controller never constructs `{ data }`.** `ResponseEnvelopeInterceptor`
does that for every handler. A controller that wraps by hand produces
`{ data: { data: … } }`, and the bug is invisible in any test written by the same
person in the same hour.

### 3.2 The controller

It does four things: declare the route, declare the DTOs, call exactly one
service method, and return what that returns. A handler longer than about five
lines is usually holding a business rule that belongs one layer down — the test
is whether the line would still make sense if this were a CLI command rather than
an HTTP request.

It does not catch exceptions. `AllExceptionsFilter` renders every throwable as one
`ApiFailure`, and a `try`/`catch` in a handler is how a feature acquires a second
error shape.

On a protected route it also takes the caller, `@CurrentCaller() caller: Caller`,
and passes it to the service (§3.6).

### 3.3 The service

Business rules, orchestration across repositories, and the transaction boundary
(§7) — which belongs here because this is the layer that knows which writes have
to succeed or fail together.

It is the **only** layer that throws `HttpException`, and it throws with a named
code (§6.2). It takes and returns plain objects; it never sees `Request`, so
anything it needs from the request — a caller id, an idempotency key — arrives as
an argument.

### 3.4 The repository

All SQL for one resource, and **the single point of enforcement for the two rules
the database cannot enforce** (`docs/schema-conventions.md`, closing section):

1. **Every statement filters `deleted_at IS NULL`** — on a table that opted into
   soft delete, and that means writes as well as reads. A select that forgets it
   returns deleted rows; an update that forgets it edits a deleted row. Both
   silently.
2. **Every update carries `AND version = $n`** — on a table that carries
   `version`. Forgetting clobbers a concurrent write, successfully.

Neither has a constraint behind it, and both are silent. Three consequences for
how a repository is written:

**No general `query` escape hatch.** Decision 8 is explicit that a repository
exposing raw access to everyone has the cost of the indirection and none of the
benefit. Where raw SQL is genuinely needed — a reporting query Drizzle's DSL
cannot express — it is a **named method on the repository** whose comment says
why, not a passthrough.

**Methods return rows or `null`, never throw for absence.** See §3.1.

**The filter and the predicate are applied in the method, not in a wrapper.** A
`findAll` helper on a base class that injects `isNull(deletedAt)` reads as the
stronger guarantee and is not one: the next method that needs a different `where`
writes it by hand and the wrapper is silently bypassed. Repetition that is
visible in a diff beats abstraction that is bypassable without one. **This is the
thing the reviewer checks on every repository commit.**

**And be clear about what that does and does not achieve**, because the phrasing
here used to overclaim and `docs/schema-conventions.md` has since been corrected.
Repeating the filter per method does not *enforce* it — it locates the repetition
somewhere a reviewer can find it. The mechanism that actually enforces the
soft-delete filter is a view: expose the live rows as an auto-updatable view
`WITH CHECK OPTION` and grant the runtime role the view instead of the table, and
omitting the filter stops being expressible. That is the better answer for a
soft-deleted table, it depends on a DDL/runtime grant split this project has not
built yet, and its costs are in that document's closing section. The version
predicate has no equivalent — a guard trigger catches a missing version *bump* but
not a missing `WHERE` — so for that rule the repository really is the only place
it can be applied in full.

### 3.5 The mapper

**Choice: a hand-written function per resource returning a declared response
interface.**

**Rejected: returning the row; `nestjs-zod`'s `ZodSerializerDto`.**

Returning the row makes every future column part of the public contract the moment
it is added — including `deleted_at`, an internal flag, a column added for a
background job — and nothing in the type system objects, because the handler's
return type is simply the row type.

An explicit interface plus a mapper makes the contract a thing you can read, and
TypeScript's excess-property check on the returned object literal fails the build
when a field is misspelled or removed. `ZodSerializerDto` would validate the
response at runtime and strip unknown keys, which is genuinely stronger against
accidental leakage; it is declined here because it needs a second interceptor
registered globally and its ordering against the envelope interceptor reasoned
about, and because a compile error is a better failure than a stripped field
nobody notices. A project that wants both can add it later without changing any
mapper.

`version` **is** exposed. Optimistic concurrency pushes it onto the client by
design (decision 7), so it is part of the contract rather than a leak.

### 3.6 Authorization

`AuthGuard` (`src/auth/auth.guard.ts`) is registered as `APP_GUARD`, so **every
route needs a valid access token by default**. A route that must be reachable
without one is marked `@Public()` on the controller or the handler. Today that is
`AuthController` (it is how a client gets a token) and `HealthController`.
Forgetting `@Public()` fails closed with a 401. Forgetting the guard is not
possible.

The guard reads `Authorization: Bearer <jwt>` and verifies it through
`AccessTokensService.verify`: HS256 only, `exp` required, and `sub` and `sid`
present. Anything else, including no header, is `401 TOKEN_INVALID`. On success
it attaches a `Caller` (`{ userId, sessionId }`) to the request.

**The guard is stateless.** It does not look the session up, so a session that
was signed out or revoked keeps passing the guard until its access token
expires (`ACCESS_TOKEN_TTL_SECONDS`, 15 minutes by default). An endpoint that
must refuse a dead session at once reads the session itself, as `GET /me` does.

The caller travels as an argument:

```ts
@Get()
list(@CurrentCaller() caller: Caller, @Query() query: ListNotesQuery) {
  return this.notes.list(caller, query);
}
```

The service scopes every read and write by `caller.userId`. It never trusts a user
id from the body, the path or the query. A row that belongs to someone else is a
404, not a 403, so the API does not reveal that the id exists.

`@CurrentCaller()` on a `@Public()` route throws, since there is no caller to read.

---

## 4. The request contract

### 4.1 Every parameter is a DTO class. There are no exceptions.

`src/validation/validation.pipe.ts` sets `strictSchemaDeclaration: true`, which
makes the pipe throw when a `@Body()`, `@Query()` or `@Param()` has no zod schema
on its declared type. Verified against this repository:

```ts
@Get(':id')
bad(@Param('id') id: string) {}      // 500 INTERNAL_ERROR, opaque body
```

```ts
class NoteIdParams extends createZodDto(z.object({ id: z.uuid() })) {}

@Get(':id')
good(@Param() params: NoteIdParams) {}   // 200, and a bad uuid is a 400
```

The failure is `ZodSchemaDeclarationException`, which extends
`InternalServerErrorException` — so `AllExceptionsFilter` replaces its message
with `An unexpected error occurred.` and the response says nothing useful. The
real cause is in the log, at `error`, with a stack. **Recognise this shape: a 500
on a route that does nothing but read a path parameter is almost always a missing
DTO.**

A global pipe applies to every parameter, so a param-level pipe instance does not
rescue a bare parameter — the global one throws first. Write the DTO.

The one exemption is a custom parameter decorator (`metadata.type === 'custom'`),
such as `@CurrentCaller()`. Its value comes from the server, not the client, so
the pipe passes it through untouched. The exemption covers only that kind:
`@Body()`, `@Query()` and `@Param()` still fail closed.

### 4.2 Bodies are strict; queries coerce

**Request bodies use `z.strictObject`** (or `.strict()`; both exist in zod 4).
Plain `z.object` **silently strips** unknown keys — verified: a body of
`{ title: 'x', extra: 1 }` is accepted as `{ title: 'x' }`. So `titel: 'typo'`
becomes a request with no title at all and the caller is told nothing about the
field they actually sent. Strict turns it into a 400 naming the key. This is the
same fail-closed choice as the logging header allowlist and
`strictSchemaDeclaration`.

**Query parameters arrive as strings, so every non-string needs `z.coerce`** and
usually a `.default()`:

```ts
export class ListNotesQuery extends createZodDto(
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.uuid().optional(),
  }),
) {}
```

Verified: absent `limit` yields the number `20`, `?limit=5` yields `5`, and
`?limit=999` is a 400 with `details[0].path === 'limit'`. Queries are **not**
strict — an unknown query parameter is usually a tracking tag or a stale client,
and failing the request over one is worse than ignoring it.

### 4.3 DTO conventions

One file per DTO under `dto/`, named `<verb>-<resource>.dto.ts`. Class name
matches the operation (`CreateNoteBody`, `UpdateNoteBody`, `ListNotesQuery`,
`NoteIdParams`). Export the zod schema too where a test or another schema needs to
compose it.

**A DTO is the API contract, not the row.** They diverge immediately and should:
the row has `id`, `version`, `created_at` and the create body has none of them.
`drizzle-zod` can derive a schema from a table and is the right tool at the *row*
boundary — inside the repository — not at the request boundary.
`docs/database-decisions.md` §2 is explicit that it removes duplication at the row
boundary and does not unify the two shapes.

### 4.4 Paths and methods

`configure-app.ts` composes prefix / version / controller path, so
`@Controller('notes')` answers on `/api/v1/notes`.

| operation | method and path | notes |
|---|---|---|
| list | `GET /notes` | cursor paginated, §5.2 |
| read one | `GET /notes/:id` | |
| create | `POST /notes` | 201 |
| update | `PATCH /notes/:id` | partial; carries `version` |
| delete | `DELETE /notes/:id` | 204, no body |

Plural nouns, no verbs in paths. An operation that is genuinely not CRUD gets a
sub-resource rather than a verb — `POST /notes/:id/archive`, not
`POST /notes/:id/doArchive`. Nesting stops at one level: `/notes/:id/comments` is
fine, `/users/:id/notes/:noteId/comments` is a list endpoint with a filter
pretending to be a path.

**`PATCH`, not `PUT`.** `PUT` means replace-whole-resource, which with `version`
and server-maintained columns is not what any of these endpoints do. Declaring
`PUT` and then merging is the kind of small lie that makes a client author guess.

---

## 5. The response contract

### 5.1 The envelope is not yours to change

Every success is `{ data: … }` and every failure is `{ error: { code, message,
details? } }`, produced by `ResponseEnvelopeInterceptor` and
`AllExceptionsFilter`. A feature adds neither a field to the envelope nor a
second shape inside it. `@NoEnvelope()` exists for bodies that are not ours to
shape — a file download, a redirect, a format an external consumer fixed — and
is not an opt-out for convenience.

**Values a client acts on go in `error.meta`**, and nowhere else: throw
`new BadRequestException({ code, message, meta: { attemptsLeft: 2 } })`.
`AllExceptionsFilter` copies `meta` onto a 4xx and drops every other key on the
thrown object, so a field reaches the client only if it was put there for them.
`meta` holds scalars only, with one exception: `STALE_VERSION` (§6.3) carries the
current resource as `meta.current`. The filter lets an object through for that
code and that key only, and renders it as given, so pass the mapped response
type (e.g. `toProfile(row, …)`), never a row. `MeService.update` is the first
example.

### 5.2 List endpoints: cursor pagination, inside `data`

**Choice: keyset (cursor) pagination on `id`, with the page metadata inside
`data`.**

```json
{ "data": { "items": [ … ], "nextCursor": "0190d4f0-…" } }
```

`nextCursor` is `null` on the last page. The client passes it back as `?cursor=`.

**Rejected: a top-level `meta` sibling to `data`.** It is the more conventional
shape and it would mean editing `src/http/envelope.ts` and the interceptor — a
change to the contract of every endpoint in every cloned project, made on behalf
of one. Putting the page metadata inside `data` needs no envelope change, keeps
the discriminator (`error` present or not) intact, and costs one level of nesting.

**Rejected: `limit`/`offset` with a total count.** Two reasons. `OFFSET 10000`
makes the database count and discard ten thousand rows on every request, so the
last page is the slowest. And under concurrent inserts offset pagination is
*wrong*, not merely slow — a row inserted before page 2 is fetched shifts
everything down and the client sees one row twice and never sees another. A total
count is also a full scan of the filtered set; where a product genuinely needs
one it is a separate, explicitly-cached endpoint, not a field every list query
pays for.

**The cursor is the `id`, and that is a consequence of decision 4.** UUIDv7 is
time-ordered, so `ORDER BY id DESC` is newest-first, `WHERE id < $cursor` is
"older than the last row you saw", and the primary key index already serves both —
so per `docs/schema-conventions.md` §11 this pagination needs **no new index**.
Ids are unique, so there are no ties and no compound cursor. Fetch `limit + 1`
rows, and if you got them, the first `limit` are the page and the extra row's
existence is what sets `nextCursor`.

Three honest limits. The cursor is opaque by convention only — it is a visible
UUID, and a client could construct one; nothing breaks if it does. And this orders
by creation, so an endpoint needing a different sort order needs a different
cursor, which is a compound `(sortKey, id)` and a matching index, with its
justifying query in the commit message.

The third is the one that will bite someone. **This cursor is safe for paging and
unsafe for "give me everything since X".** A UUIDv7 is generated when the
statement runs, not when the transaction commits, so a transaction that starts
earlier and commits later carries a *lower* id than one already visible. Paging
backwards through existing rows is unaffected — the sort key is unique and
immutable, which is all keyset pagination needs. But a client polling forward with
`id > lastSeen` can step past a row that had not committed yet and never see it
again, with nothing anywhere reporting a loss. `created_at` has the identical flaw,
being transaction start time. A sync or change-feed endpoint therefore needs a
different mechanism than this one, and must not be built by pointing a client at
this cursor.

### 5.3 Status codes

| | status | body |
|---|---|---|
| `GET` one, `GET` list, `PATCH` | 200 | the resource, or the page |
| `POST` create | **201** | the created resource |
| `DELETE` | **204** | none |

201 is Nest's default for `POST` — verified — so it needs no decorator. 204 needs
`@HttpCode(HttpStatus.NO_CONTENT)` and a handler that returns nothing:
`ResponseEnvelopeInterceptor` leaves `undefined` unwrapped precisely so that an
empty body stays empty rather than becoming `{ "data": null }`.

`DELETE` is idempotent, so deleting an already-deleted row is **204, not 404**.

### 5.4 `version` travels both ways

A resource that carries `version` returns it on every read and requires it on
every update. Put it in the `PATCH` body.

**Rejected: `ETag` and `If-Match`.** It is the correct HTTP mechanism and it
needs an ETag to be generated, a 412 and a 428 added to `ErrorCode`, and a
precondition layer that does not exist. The body field is a smaller contract that
says the same thing, and `If-Match` can be added over it later without changing
the semantics.

---

## 6. Errors

### 6.1 Three ways an error reaches a client

Know which one is answering, because two of them are floors you should usually be
pre-empting rather than relying on.

1. **A named throw from the service.** `throw new ConflictException({ code:
   'NOTE_TITLE_TAKEN' satisfies ErrorCode, message: '…' })`. This is the only one
   that produces a message written for the caller and a code specific enough to
   branch on. Prefer it.
2. **The driver-error map** (`src/database/driver-error.ts`). A constraint
   violation nobody caught becomes a 409 or a 422 with a generic code and a fixed
   message. It is deliberately the floor, not the mechanism —
   `docs/database-decisions.md` §10 explains why per-constraint codes are not kept
   in the HTTP layer. A 409 with `code: 'CONFLICT'` in a response means nobody
   decided what that conflict was.
3. **`AllExceptionsFilter`'s last branch.** 500, `INTERNAL_ERROR`, opaque
   message. Anything reaching here is a bug or an unmapped failure.

### 6.2 Adding an error code

`src/http/error-code.ts` is **append-only**: clients branch on these, so a code is
never renamed and never repurposed. Add a code when a client would plausibly do
something different about it — retry, re-read, show a specific field, send the
user elsewhere. Do not add one per constraint out of symmetry; a code nothing
branches on is a string the caller ignores and a line everyone maintains.

The generic codes already in the union are the right answer more often than not.
Two that the first feature will want and the skeleton does not ship:
`STALE_VERSION` (§6.3) and whatever the idempotency-replay case is called. Add
them to the union in the same commit as the code that throws them.

### 6.3 The answers every write endpoint owes

A write endpoint is not finished until it has an answer for each of these. The
repository returns the left column; the service maps it to the right.

| repository returns | meaning | service responds |
|---|---|---|
| `null` from a read | no such row, or it is soft-deleted | `404` `NOT_FOUND` |
| `{ outcome: 'missing' }` from a versioned update | no such row | `404` `NOT_FOUND` |
| `{ outcome: 'stale', row }` from a versioned update | the row exists, `version` did not match | `409` `STALE_VERSION`, **carrying `row` as the current state** |
| a unique violation on `uq_*_idempotency_key` | a retry of an operation already in flight or done | see below |
| any other constraint violation | a rule the data must satisfy | a named `409`/`422`, or the §6.1 floor |

**Rows two and three are one trap.** A versioned update returning zero rows is
ambiguous between "no such row" and "stale version", because the `WHERE` clause
tested both. Reporting 404 for the second sends the client off to create a
duplicate, so the repository has to tell them apart — it re-reads by id after a
zero-row update and returns that row *with* the verdict, so the service can put
the current state into the 409 without a third query. Returning the current state
is what lets the client re-read and retry in one round trip, and decision 7 puts
that obligation on the *first* endpoint rather than on a later refinement.

**That re-read is deliberately not wrapped in a transaction, and the reason is
worth being exact about**, because reaching for one is the instinct and it is the
wrong instinct. Under READ COMMITTED — the default, and the level
`docs/schema-conventions.md` §10 is built on — **each statement takes its own
snapshot.** A transaction around these two would give them a shared connection,
not a shared view of the data: it adds a `BEGIN` and a `COMMIT` and guarantees
nothing the two bare statements do not already have. The one interleaving neither
version prevents is a concurrent delete between the update and the re-read, which
yields `missing` and a 404 — and that is honest, because by the time we answer the
row really is gone.

If the extra round trip is worth removing, the two statements collapse into one —
and *that* genuinely is a single snapshot, since every part of one query sees the
same one, and a data-modifying CTE's effects are invisible to the rest of it. It
goes in as a named raw-SQL method per §3.4:

```sql
WITH attempt AS (
  UPDATE notes SET title = $3, version = version + 1
  WHERE id = $1 AND version = $2
  RETURNING *
)
SELECT 'updated' AS outcome, * FROM attempt
UNION ALL
SELECT 'stale' AS outcome, n.* FROM notes n
WHERE n.id = $1 AND NOT EXISTS (SELECT 1 FROM attempt);
```

Zero rows back is `missing`; one row carries its own verdict.

**The fourth row is not an error, and it is the one with a security condition
attached.** Telling this constraint from every other unique violation is possible
only by its name, which `docs/schema-conventions.md` §9 notes is the second place
the naming convention is load-bearing. The name is read with `uniqueViolation`
from `src/database/driver-error.ts`, which exists for this caller:

```ts
const duplicate = uniqueViolation(error);

if (duplicate?.constraint === 'uq_notes_owner_idempotency_key') {
  // the retry working, not a failure — see below for what may be returned
}
```

Use it rather than inspecting the error yourself. Recognising a driver error means
checking `severity` as well as the SQLSTATE shape, and knowing why
`instanceof DatabaseError` is unsafe across two copies of `pg-protocol`; all of
that reasoning lives in that file, and a second copy in a feature folder is the
one that goes stale. Note the two levels of `undefined` it documents — the outer
means "not a duplicate", the inner means "a duplicate whose rule Postgres did not
name".

What a replay may *return* depends on the constraint being scoped to the caller.
With `UNIQUE (owner_id, idempotency_key)` and a verified principal, a replay whose
original has committed returns the original result. **Without that scope — which is
this skeleton today, having no authentication — a replay is a `409` and never a
body**, because an unscoped key is a credential: whoever presents it would be
handed the row it created. A replay racing a still-uncommitted original cannot see
it either, so that case is the same `409` meaning *in progress, retry shortly* — not
a replayed result, and not a null dereference on a path that only runs under
concurrency.

---

## 7. Transactions

**All of this is wired already** — `src/database/database.module.ts` exports the
`DB` token and the `Schema`, `Db`, `Tx` and `Executor` types, and both `POOL` and
`DB` are exported from the `@Global()` module. A feature imports them; it builds
nothing.

```ts
import { DB, type Executor } from '../database/database.module';
```

`DB` is Drizzle built **on `POOL`**, not on a second connection string. That is
why every Drizzle query inherits the pool's limits, `statement_timeout`,
`application_name`, UTC session zone and per-statement slow-query logging without
a feature doing anything. Inject `DB`; reach for `POOL` only where the DSL cannot
express the statement, and then as a named repository method (§3.4).

`Tx` is derived from `Db` rather than imported, because Drizzle publishes no name
for it. Verified to compile against `drizzle-orm` 0.45.

**Every repository method takes an executor, and it has no default:**

```ts
async findById(ex: Executor, id: string): Promise<NoteRow | null> { … }
```

**The absent default is the point, and it is worth one paragraph because the
default is the obvious thing to write.** `ex: Executor = this.db` reads as a
convenience and behaves as a trap: a service inside a transaction that forgets to
pass `tx` silently runs that statement on a *different connection*, outside the
transaction. There is no type error, no runtime error, and no wrong answer until
something fails and half the writes are already committed. That is the same
"forgetting is silent" shape as the version predicate, and the rest of this
project refuses to tolerate it wherever a compiler can be made to object instead.
Required means the compiler objects.

It also goes **first** rather than last. A trailing required parameter is easy to
drop on a method that already takes three arguments; a leading one cannot be
omitted without the call failing to compile for an obvious reason. The cost is
that every call site reads `this.notes.findById(this.db, id)`, which is noisier
than `findById(id)` — and that noise is the executor being visible at the point
where choosing the wrong one would be a bug.

The service opens a transaction only where two writes must succeed or fail
together, and passes `tx` down explicitly:

```ts
await this.db.transaction(async (tx) => {
  const note = await this.notes.create(tx, input);
  await this.audit.record(tx, { noteId: note.id });
  return note;
});
```

Three rules, each of which is a cost decision 8 already itemised:

**Nothing slow goes inside.** No HTTP call, no email, no payment provider. The
transaction holds every lock it has taken for the duration, and
`IDLE_IN_TRANSACTION_TIMEOUT_MS` in `database.module.ts` exists because that
pattern degrades a database it is not even querying.

**The executor is passed, never stored.** A repository that keeps a `tx` on
itself is shared mutable state across concurrent requests in a singleton
provider. Decision 8 also rules out `AsyncLocalStorage` for this, with the
finding recorded there — do not reopen it without reading that entry.

**A read-only request does not open one.** A single statement is already atomic.

---

## 8. Logging in a feature

Usually: **write nothing.** `pino-http` logs a completion line per request with
`reqId`, `AllExceptionsFilter` logs every failure with the code it mapped to, and
`installQueryLogging` logs every statement with its duration under the same
`reqId`. A handler that logs "creating note" adds a line that says less than the
three that already exist.

Log deliberately when a line carries something none of those can know — a business
decision taken, an external call's outcome, a branch that should be rare. Inject
`PinoLogger`, set its context to the class name in the constructor as
`HealthController` does, and pass structured fields rather than interpolating:
`this.logger.warn({ noteId }, 'archived a note with open comments')`.

Never log a parameter value, a request body or anything derived from user input
beyond an id. `query-logging.ts` counts parameters rather than reading them and
`driver-error.ts` drops Postgres's `detail` field, both for this reason — a
feature that logs the body undoes both in one line.

---

## 9. Tests a feature owes

Three kinds, because they fail for different reasons.

**Repository — integration, against a real Postgres.** The only layer whose
correctness is invisible by reading, and the layer holding the two rules no
constraint stands behind, so the tests that matter are the ones that would pass if
those rules were missing: a soft-deleted row **is not** returned by any read method
**and cannot be modified by any write method**; an update with a stale `version`
changes nothing and reports it, distinguishably from a missing row; pagination
returns each row exactly once across pages while a row is inserted between them;
the idempotency constraint actually fires on a replay, and does *not* fire across
two owners.

**Service — unit, with a fake repository.** One per branch of the §6.3 table:
each repository outcome produces the right status and the right `ErrorCode`. No
database, no HTTP.

**Endpoint — e2e, through the real `AppModule`.** The wire contract: the path
including `/api/v1`, the status code, the envelope, `X-Request-Id`, and the
`error.code` for each failure. Follow `test/app.e2e-spec.ts`, which builds the app
with `bodyParser: false` and calls `configureApp` — those lines are load-bearing,
and the comment there records the bug their absence caused. Write the path out
literally rather than composing it from `API_PREFIX`; the existing spec explains
why a derived path makes the assertion tautological.

**Test isolation is decision 9 in `docs/database-decisions.md`.** Each spec that
touches the database truncates the tables it uses in `beforeEach`
(`TRUNCATE … RESTART IDENTITY CASCADE`), and jest runs with `--runInBand` so two
files cannot interleave against one database. Open the database for a repository
spec with `openTestDatabase()` from `src/database/testing.ts`. The suite empties
whatever `DATABASE_URL` names, so never point it at data you want.

---

## 10. Worked example: `notes`

The whole of one resource, as the specification for the first slice. `notes`
carries `version` (edited through read-modify-write by anyone holding the id) and
`idempotency_key` (creates are retryable). It does **not** carry `deleted_at`:
`docs/schema-conventions.md` §8 makes soft delete opt-in with a stated reason, and
there is no restoration requirement here. §10.8 shows what changes if a table does
opt in.

### 10.1 The table

```ts
// src/database/schema.ts
import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // schema-conventions §10: read-modify-write by more than one writer.
    version: integer('version').notNull().default(0),
    // schema-conventions §9: POST /notes is retryable. Nullable — PostgreSQL
    // treats a row with a NULL in the index as distinct from every other, so a
    // create without a key is still allowed.
    idempotencyKey: uuid('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Unscoped, because `notes` has no owner — this skeleton has no authentication,
  // so there is no principal to scope to. That is why §6.3 answers a replay with a
  // 409 and never a body. When an owner column arrives, this becomes
  // `.on(table.ownerId, table.idempotencyKey)` renamed
  // `uq_notes_owner_idempotency_key`, in the *same* migration as that column:
  // schema-conventions §9 is explicit that retrofitting the scope later means
  // rebuilding the index under a lock.
  (table) => [uniqueIndex('uq_notes_idempotency_key').on(table.idempotencyKey)],
);

export type NoteRow = typeof notes.$inferSelect;
```

### 10.2 The migration

`npm run db:migrate:create` writes the `CREATE TABLE`. **Read it**, then append
the trigger by hand — `set_updated_at()` already exists, and the `WHEN` clause is
what stops a no-op update bumping the column:

```sql
CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION set_updated_at();
```

That trigger is invisible to the Drizzle snapshot, so the same commit adds it to
the escape-hatch register in `docs/database-decisions.md`. No other index: §5.2's
pagination is served by the primary key, and `docs/schema-conventions.md` §11
wants an index's justifying query before the index.

### 10.3 DTOs

```ts
// dto/create-note.dto.ts
export class CreateNoteBody extends createZodDto(
  z.strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(10_000).default(''),
    idempotencyKey: z.uuid().optional(),
  }),
) {}

// dto/update-note.dto.ts — partial, but `version` is mandatory
export class UpdateNoteBody extends createZodDto(
  z.strictObject({
    version: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(10_000).optional(),
  }),
) {}

// dto/note-id.dto.ts
export class NoteIdParams extends createZodDto(z.object({ id: z.uuid() })) {}

// dto/list-notes.dto.ts
export class ListNotesQuery extends createZodDto(
  z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.uuid().optional(),
  }),
) {}
```

### 10.4 Response type and mapper

```ts
// notes.mapper.ts
export interface NoteResponse {
  id: string;
  title: string;
  body: string;
  version: number;     // the client must send this back to update (§5.4)
  createdAt: string;
  updatedAt: string;
}

export function toNoteResponse(row: NoteRow): NoteResponse {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

`idempotencyKey` is absent, deliberately — it is the caller's own value and
echoing it adds a field to the contract that nothing reads.

### 10.5 Repository

Every method takes the executor first and has no default (§7), and every
array destructure handles the empty case — `noUncheckedIndexedAccess` in
`tsconfig.json` is on precisely so that it has to.

```ts
export type VersionedUpdate =
  | { outcome: 'updated'; row: NoteRow }
  | { outcome: 'stale'; row: NoteRow }
  | { outcome: 'missing' };

@Injectable()
export class NotesRepository {
  async findById(ex: Executor, id: string): Promise<NoteRow | null> {
    const [row] = await ex.select().from(notes).where(eq(notes.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * One page, newest first. Fetches `limit + 1` so the caller can tell whether
   * another page exists without a second query or a count.
   */
  async list(
    ex: Executor,
    { limit, cursor }: { limit: number; cursor?: string },
  ): Promise<{ items: NoteRow[]; nextCursor: string | null }> {
    const rows = await ex
      .select()
      .from(notes)
      // `id` is UUIDv7, so ordering by it is ordering by creation time, and the
      // primary key index serves both the order and the cursor — §5.2.
      .where(cursor === undefined ? undefined : lt(notes.id, cursor))
      .orderBy(desc(notes.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit);

    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async create(ex: Executor, input: NewNote): Promise<NoteRow> {
    const [row] = await ex.insert(notes).values(input).returning();

    // An insert with `returning()` that produced no row is not a case a caller
    // can do anything about — it means the statement did not do what the type
    // says it does. A bare `Error` is right: it reaches the client as the 500 it
    // is, and §3.1's ban is on *HTTP* exceptions, not on failing loudly.
    if (row === undefined) throw new Error('insert returned no row');

    return row;
  }

  /**
   * Conditional on the version read — one of the two rules no constraint stands
   * behind (`docs/schema-conventions.md`, closing section). `version` is
   * incremented in the same statement, so no read-modify-write exists to be
   * raced.
   *
   * A zero-row update cannot distinguish "no such row" from "someone else wrote
   * first", and answering 404 for the second sends the client off to create a
   * duplicate — so a zero-row update is followed by a read, and the row it finds
   * travels back with the verdict. That saves the caller a third query for the
   * state the 409 has to carry.
   *
   * **No transaction, deliberately.** READ COMMITTED gives each statement its
   * own snapshot, so wrapping these two would share a connection rather than a
   * view of the data — a `BEGIN` and a `COMMIT` buying nothing. §6.3 has the
   * argument and the single-statement form for when the round trip matters.
   */
  async updateVersioned(
    ex: Executor,
    id: string,
    version: number,
    patch: Partial<Pick<NoteRow, 'title' | 'body'>>,
  ): Promise<VersionedUpdate> {
    const [row] = await ex
      .update(notes)
      .set({ ...patch, version: sql`${notes.version} + 1` })
      .where(and(eq(notes.id, id), eq(notes.version, version)))
      .returning();

    if (row !== undefined) return { outcome: 'updated', row };

    const current = await this.findById(ex, id);

    return current === null
      ? { outcome: 'missing' }
      : { outcome: 'stale', row: current };
  }

  async deleteById(ex: Executor, id: string): Promise<void> {
    await ex.delete(notes).where(eq(notes.id, id));
  }
}
```

Note `updatedAt` is absent from the `set` — the trigger owns it
(`docs/schema-conventions.md` §3), and setting it here would take the timestamp
from Node's clock instead of the transaction's.

### 10.6 Service

```ts
@Injectable()
export class NotesService {
  // `DB` is injected because the repository takes its executor as an argument and
  // has no default (§7) — not because this service opens a transaction. It does
  // not; see the comment in `update`.
  constructor(
    private readonly notes: NotesRepository,
    @Inject(DB) private readonly db: Db,
  ) {}

  async get(id: string): Promise<NoteResponse> {
    const row = await this.notes.findById(this.db, id);
    if (row === null) throw this.notFound(id);
    return toNoteResponse(row);
  }

  async update(id: string, { version, ...patch }: UpdateNoteBody): Promise<NoteResponse> {
    // No transaction: this is one write, and the repository's own re-read needs
    // none — see §6.3. A service opens one where two writes must land together,
    // which is the §7 snippet, not this.
    const result = await this.notes.updateVersioned(this.db, id, version, patch);

    if (result.outcome === 'missing') throw this.notFound(id);

    if (result.outcome === 'stale') {
      // The current state travels with the 409 so the caller can re-read and
      // retry in one round trip — the client-side obligation decision 7 names.
      throw new ConflictException({
        code: 'STALE_VERSION' satisfies ErrorCode,
        message: 'This note was changed by someone else. Re-read it and retry.',
        current: toNoteResponse(result.row),
      });
    }

    return toNoteResponse(result.row);
  }

  private notFound(id: string): NotFoundException {
    return new NotFoundException({
      code: 'NOT_FOUND' satisfies ErrorCode,
      message: `No note with id ${id}.`,
    });
  }
}
```

`STALE_VERSION` is added to `src/http/error-code.ts` in the same commit (§6.2).

### 10.7 Controller and module

```ts
@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  list(@Query() query: ListNotesQuery) {
    return this.notes.list(query);
  }

  @Get(':id')
  get(@Param() { id }: NoteIdParams) {
    return this.notes.get(id);
  }

  @Post()
  create(@Body() body: CreateNoteBody) {   // 201 by default
    return this.notes.create(body);
  }

  @Patch(':id')
  update(@Param() { id }: NoteIdParams, @Body() body: UpdateNoteBody) {
    return this.notes.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param() { id }: NoteIdParams): Promise<void> {
    await this.notes.remove(id);   // returns nothing: 204, empty body
  }
}
```

```ts
@Module({
  controllers: [NotesController],
  providers: [NotesService, NotesRepository],
})
export class NotesModule {}
```

No `imports`: `DatabaseModule` is `@Global()`, so `DB` is injectable without
importing it. Add `NotesModule` to `src/app.module.ts`'s `imports`.

### 10.8 If the table opts into soft delete

Four changes:

- **Every read gains `isNull(notes.deletedAt)`** — `findById`, `list`, and the
  re-read inside `updateVersioned`. In the `where`, written out each time; not in
  a shared wrapper (§3.4).
- **So does every write.** `updateVersioned`'s `UPDATE … WHERE` gains it too, or a
  soft-deleted note stays editable — and the 404 the endpoint returns for reading
  it makes that impossible to notice from the outside. The filter is a property of
  the table, not of reads.
- **Every unique constraint becomes a partial index**, or a deleted row occupies
  the value forever: `CREATE UNIQUE INDEX uq_notes_slug ON notes (slug) WHERE
  deleted_at IS NULL;`
- **`deleteById` becomes an update**, and the repository test asserts that a
  soft-deleted row is absent from every read path *and* rejected by every write
  path — which is the test that fails when someone adds a fourth method and
  forgets the filter.

**Consider the view instead of all of the above.** `CREATE VIEW notes_live AS
SELECT * FROM notes WHERE deleted_at IS NULL WITH CHECK OPTION`, with the
repository reading and writing the view and touching the base table only to set
`deleted_at`, makes the first two bullets unnecessary rather than obligatory — a
forgotten filter becomes inexpressible. It needs the view in a migration and in
the escape-hatch register, declared to Drizzle as a `pgView`, and it only becomes
real enforcement once the runtime role is granted the view rather than the table,
which this project has not built. `docs/schema-conventions.md`'s closing section
has the full trade.

---

## 11. Review checklist

A feature is ready when every line is true. Most of them are things no test will
catch.

**Contract**

- [ ] Paths are plural nouns under `/api/v1`; no verbs; nesting at most one level
- [ ] 201 on create, 204 and an empty body on delete, 200 elsewhere
- [ ] Lists are cursor paginated as `{ data: { items, nextCursor } }`; no `offset`, no total
- [ ] No handler constructs `{ data }`; `@NoEnvelope()` used only where the body is not ours
- [ ] `version` is returned on reads and required on updates, if the table carries it

**Validation**

- [ ] Every `@Body()`, `@Query()` and `@Param()` is a `createZodDto` class — no bare parameters
- [ ] Bodies use `z.strictObject`; query parameters use `z.coerce` and `.default()`

**Data**

- [ ] `version`, `deleted_at` and `idempotency_key` each present or absent for a reason stated in the migration
- [ ] Constraints, indexes and triggers named explicitly with their prefixes
- [ ] The generated migration was read, not just generated
- [ ] Anything hand-written into the migration is in the escape-hatch register
- [ ] `updated_at` is left to the trigger — no `set({ updatedAt })` anywhere
- [ ] Any new index has its justifying query in the commit message
- [ ] `npm run db:migrate` was confirmed by querying the bookkeeping table, not by its output

**Boundaries**

- [ ] No SQL or Drizzle import outside the repository
- [ ] No `HttpException` inside the repository; no `Request`/`Response` inside the service
- [ ] Every read **and every write** filters `deleted_at IS NULL`, if the table has it — in each method
- [ ] Every update carries the version predicate, if the table has it — in each method
- [ ] Rows reach the client only through the mapper; no row type in a handler's return
- [ ] Repository methods take `ex: Executor` **first and with no default**; nothing stores a transaction
- [ ] Every array destructure of a query result handles the empty case
- [ ] No network call, email or payment inside a transaction

**Errors**

- [ ] Every row of §6.3 has an answer
- [ ] A stale version is a 409 carrying the current state, distinguished from 404
- [ ] Idempotent replay is handled by constraint name via `uniqueViolation`, not by a pre-check or a hand-rolled error check
- [ ] The idempotency index is scoped to the caller, or the replay returns 409 with no body
- [ ] New `ErrorCode` members added in the same commit, appended, never renamed
- [ ] No `try`/`catch` in a controller

**Tests**

- [ ] Repository integration tests assert the soft-delete filter and version predicate hold
- [ ] A service unit test per §6.3 branch
- [ ] An e2e asserting the literal path, status, envelope and `error.code`
- [ ] If this is the first feature: the `AppController`/`AppService` stub and its spec are gone, and the e2e points at a real endpoint
- [ ] `npm run lint`, `npm test`, `npm run test:e2e` pass

---

## 12. What this document does not settle

Listed so their absence is not read as a position.

**Idempotent replay.** Authorization now exists (§3.6), so an idempotency key can
be scoped to its owner and a replay can return the original response instead of
`409` (§6.3, and `docs/schema-conventions.md` §9). No feature has built that yet,
and the `notes` example above still shows the unscoped form. The first create
endpoint with an owner column builds it, and the owner column and the scoped
unique index have to land in the same migration.

**Rate limiting.** `TOO_MANY_REQUESTS` is in `ErrorCode` and nothing can produce
it.

**A request timeout is no longer on this list.** `REQUEST_TIMEOUT_MS` and
`RequestTimeoutInterceptor` bound a request at 15s and answer a 504 carrying the
same message a statement timeout does. Read that file before relying on it: it
stops *waiting*, it does not cancel the work, so it protects the caller and the
connection rather than the database.

**OpenAPI.** `nestjs-zod` can derive a document from the same DTOs, and nothing
is wired. Until it is, §2 step 1 — writing the URLs down — is the only
description of the API, and it lives wherever you put it.

**Test isolation beyond a serial suite.** Decision 9 records the upgrade path — a
database per worker — and why it is not built yet.

**Pagination for any order other than newest-first**, and compound cursors
(§5.2).

**Where a response shape is shared between features.** Two features returning the
same embedded object will each write a mapper, and the right moment to extract is
not settled here. Extract on the third, not the second.
