-- schema-conventions
--
-- Project-wide database conventions, applied before any business table exists.
--
-- Both directions are required. `pnpm db:verify` runs up -> down -> up in CI
-- and fails the build if the down migration is missing or does not restore the
-- previous schema.

-- Up Migration

-- Atarimae targets PostgreSQL 18+. Two features justify the floor:
--
--   uuidv7()         time-ordered primary keys, so inserts stay at the right
--                    edge of the B-tree instead of scattering across it the
--                    way uuidv4 does.
--   builtin C.UTF-8  a collation that behaves identically on a Windows dev
--                    machine and a Linux container. libc collations do not.
--
-- Failing here gives a readable error instead of a confusing one three
-- migrations later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'uuidv7' AND pronamespace = 'pg_catalog'::regnamespace
  ) THEN
    RAISE EXCEPTION
      'Atarimae requires PostgreSQL 18 or newer. Found: %', current_setting('server_version');
  END IF;
END
$$;

-- Every table carrying an updated_at column attaches this trigger. Keeping the
-- timestamp in the database means it stays correct regardless of which code
-- path performed the write.
--
-- Guards against a no-op UPDATE bumping the timestamp: if the row is unchanged,
-- updated_at is left alone.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger function maintaining updated_at. Attach as: CREATE TRIGGER trg_<table>_updated_at BEFORE UPDATE ON <table> FOR EACH ROW EXECUTE FUNCTION set_updated_at();';

-- Down Migration

DROP FUNCTION IF EXISTS set_updated_at();
