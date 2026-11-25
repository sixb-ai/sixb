-- A branch skips an Action's effects and records them as skipped. The effects check was unnamed:
-- drop the one that admits only 'succeeded' and 'failed', and name its replacement. It is
-- `NOT VALID`: a widened list cannot break a row that exists, and validating would scan
-- `action_runs` under this lock.
DO $$
DECLARE effects_constraint RECORD;
BEGIN
  FOR effects_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'action_runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%effects_status%'
  LOOP
    EXECUTE format('ALTER TABLE action_runs DROP CONSTRAINT %I', effects_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE action_runs
  ADD CONSTRAINT action_runs_effects_status_check CHECK (
    effects_status IS NULL OR effects_status IN ('succeeded', 'failed', 'skipped')
  ) NOT VALID;
