/**
 * The TypeScript description of this database's shape, and the source of truth
 * for everything `drizzle-kit`'s DSL can express.
 *
 * **It is empty, and that is not an oversight.** This repository is a backend
 * skeleton and has no domain of its own to model. The migration mechanism and
 * the conventions around it ship *before* the first table exists, so that the
 * first table — whichever project adds it — arrives already under discipline.
 *
 * Two things import it, which is why an empty file is still a real one.
 * `drizzle-kit` requires its `schema` path to resolve — it refuses to start
 * otherwise, including for `generate --custom`, which does no schema diffing at
 * all. And `database.module.ts` passes it to `drizzle(pool, { schema })`, where
 * it becomes the `Schema` type parameter: empty today, so `db.query` has nothing
 * on it, and the first `pgTable` declared here populates `db.query.<table>` with
 * no change anywhere else.
 *
 * When the first table does arrive, two things here will need saying rather
 * than assuming:
 *
 * - This file describes only what the DSL can express. Triggers, deferrable
 *   constraints and grants — the invariants that matter most — live in
 *   hand-written SQL inside migrations, invisible to the snapshot
 *   `drizzle-kit` diffs against. Reading this file as a complete description of
 *   the database will be wrong about exactly those.
 * - Editing this file changes nothing on its own. A change here is inert until
 *   `npm run db:migrate:create` turns it into SQL and `npm run db:migrate`
 *   applies it.
 */

export {};
