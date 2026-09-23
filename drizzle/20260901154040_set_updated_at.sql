-- The `updated_at` mechanism, per the *Timestamps* section of
-- `docs/schema-conventions.md`.
--
-- This ships before any table exists, and that is deliberate rather than
-- premature. A trigger in PostgreSQL is two objects: the function that runs,
-- and the attachment of that function to a particular table and event. The
-- function references no table — `NEW` is whatever row is being written — so
-- one function serves every table in the database and each table's trigger is
-- three lines pointing at it. That makes the function a schema-wide object, so
-- it belongs to the conventions rather than to any table. Only the attachment
-- is per-table, and that arrives with the table.
--
-- Note what is *not* here: the `WHEN (OLD.* IS DISTINCT FROM NEW.*)` guard that
-- stops a no-op update from bumping the timestamp. That is a property of the
-- attachment, not of the function, so it lives in each `CREATE TRIGGER`.
-- `docs/schema-conventions.md` carries the exact statement to copy.
--
-- This is the first entry in the escape-hatch register in
-- `docs/database-decisions.md` (decision 3): it exists only in this migration,
-- `drizzle-kit` cannot see it, and nothing will ever regenerate or drop it.

-- `CREATE` rather than `CREATE OR REPLACE`. A migration runs once per database,
-- so the name being taken already means something is wrong, and this run should
-- fail rather than silently overwrite whatever is there.
--
-- `SET search_path` pins name resolution to the catalog, so the function
-- behaves identically no matter what search_path the session calling it has.
-- Without it, a trigger function's behaviour is a property of the caller, which
-- is a poor thing for an invariant to depend on. It costs nothing here because
-- the body references no schema-qualified object of ours.
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- `now()` and not `clock_timestamp()`. `now()` returns the *transaction's*
  -- start time, so every row touched by one transaction carries an identical
  -- `updated_at` — a multi-row update reads back as the single event it was.
  -- `clock_timestamp()` would spray microsecond-apart values across rows that
  -- changed together, and nothing downstream could tell that apart from rows
  -- that changed separately.
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Discoverable from the catalog, for the same reason the first migration wrote
-- a comment on the schema: an object whose purpose lives only in a file in a
-- repository is an object nobody debugging a database at 3am can explain.
COMMENT ON FUNCTION set_updated_at() IS
  'BEFORE UPDATE trigger function: stamps NEW.updated_at with the transaction time. Attach per table, with WHEN (OLD.* IS DISTINCT FROM NEW.*). See docs/schema-conventions.md.';
