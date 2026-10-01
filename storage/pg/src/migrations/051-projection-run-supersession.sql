-- Projection runs gain the terminal status `superseded`, and a running run may carry the failure
-- of its last attempt in `error` while the queue retries it.

-- The status checks were unnamed. Drop exactly the two that enumerate the terminal statuses, then
-- replace them with named ones that admit `superseded`.
DO $$
DECLARE status_constraint RECORD;
BEGIN
  FOR status_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'projection_runs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%''cancelled''%'
  LOOP
    EXECUTE format('ALTER TABLE projection_runs DROP CONSTRAINT %I', status_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE projection_runs
  ADD CONSTRAINT projection_runs_status_check CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'superseded')
  ),
  ADD CONSTRAINT projection_runs_lifecycle_check CHECK (
    (status = 'queued' AND attempt = 0 AND started_at IS NULL AND finished_at IS NULL
      AND error IS NULL)
    OR (status = 'running' AND attempt >= 1 AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (
      status IN ('succeeded', 'failed', 'cancelled', 'superseded')
      AND finished_at IS NOT NULL
      AND (
        (error->>'code' = 'queue.enqueue_failed'
          AND status = 'failed' AND attempt = 0 AND started_at IS NULL)
        OR (COALESCE(error->>'code', '') != 'queue.enqueue_failed'
          AND attempt >= 1 AND started_at IS NOT NULL)
      )
    )
  ),
  -- A run is superseded instead of materialized, so it carries no failure, and only replacement
  -- runs can be: telemetry appends readings rather than replace a source.
  ADD CONSTRAINT projection_runs_superseded_check CHECK (
    status != 'superseded' OR (error IS NULL AND materialization_protocol = 'replacement')
  );
