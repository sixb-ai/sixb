-- Actions run in the request that asks for them and record their run once, when it ends. No run
-- is queued, running, or cancelled any more, and every run has started and finished.

-- A run left running after its edits committed, as a crash between the commit and the end of the
-- run left it, succeeded: its edits and their outbox facts are in the commit. A run that stopped
-- during its effects keeps that phase, and records effects that never ended.
UPDATE action_runs AS run
SET
  status = 'succeeded',
  error = NULL,
  finished_at = committed.committed_at,
  phase = CASE WHEN run.phase = 'effects' THEN 'effects' ELSE 'commit' END,
  effects_status = CASE
    WHEN run.phase = 'effects' AND run.effects_status IS NULL THEN 'failed'
    ELSE run.effects_status
  END,
  effects_completed_at = CASE
    WHEN run.phase = 'effects' AND run.effects_status IS NULL THEN now()
    ELSE run.effects_completed_at
  END,
  effects_error = CASE
    WHEN run.phase = 'effects' AND run.effects_status IS NULL THEN jsonb_build_object(
      'code', 'internal.unexpected',
      'message', 'Abandoned: Actions now run synchronously; these effects never finished.',
      'retryable', false,
      'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'details', jsonb_build_object('actionId', run.action_id, 'runId', run.id, 'phase', 'effects')
    )
    ELSE run.effects_error
  END
FROM ontology_commits AS committed
WHERE run.status IN ('queued', 'running')
  AND committed.origin_kind = 'action'
  AND committed.project_id = run.project_id
  AND committed.origin_run_id = run.id;

-- Any other run left queued or running never finished, and nothing will resume it.
UPDATE action_runs
SET
  status = 'failed',
  finished_at = now(),
  error = jsonb_build_object(
    'code', 'internal.unexpected',
    'message', 'Abandoned: Actions now run synchronously; this run never finished.',
    'retryable', false,
    'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'details', jsonb_build_object('actionId', action_id, 'runId', id)
  )
WHERE status IN ('queued', 'running');

-- A cancelled run failed: it keeps the failure it recorded.
UPDATE action_runs SET status = 'failed' WHERE status = 'cancelled';

-- Every failed run carries a failure. One recorded before failures were kept explains itself.
UPDATE action_runs
SET error = jsonb_build_object(
  'code', 'internal.unexpected',
  'message', 'This run failed before Sixb recorded why.',
  'retryable', false,
  'at', to_char(COALESCE(finished_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object('actionId', action_id, 'runId', id)
)
WHERE status = 'failed' AND error IS NULL;

-- The phases `request`, `enqueue`, and `cancelled` are gone: a run that stopped in one of them
-- never got past validation. A run starts when it was queued at the latest.
UPDATE action_runs
SET
  phase = CASE
    WHEN phase IN ('validation', 'writeback', 'edits', 'commit', 'effects') THEN phase
    ELSE 'validation'
  END,
  started_at = COALESCE(started_at, queued_at),
  finished_at = COALESCE(finished_at, now()),
  writeback_completed_at = CASE
    WHEN writeback_status IS NULL THEN NULL
    ELSE COALESCE(writeback_completed_at, finished_at, now())
  END,
  effects_completed_at = CASE
    WHEN effects_status IS NULL THEN NULL
    ELSE COALESCE(effects_completed_at, finished_at, now())
  END
WHERE phase IS NULL
  OR phase NOT IN ('validation', 'writeback', 'edits', 'commit', 'effects')
  OR started_at IS NULL
  OR finished_at IS NULL
  OR (writeback_status IS NOT NULL AND writeback_completed_at IS NULL)
  OR (effects_status IS NOT NULL AND effects_completed_at IS NULL);

-- A failure names the phase its run ended in, and only Action codes: an enqueue failure, which no
-- run can meet any more, reads as the unexpected error it now is.
UPDATE action_runs
SET error = jsonb_set(
  CASE
    WHEN error->>'code' = 'queue.enqueue_failed'
      THEN error || '{"code": "internal.unexpected", "retryable": false}'::jsonb
    ELSE error
  END,
  '{details,phase}',
  to_jsonb(phase)
)
WHERE error IS NOT NULL
  AND (
    error->'details'->>'phase' IS DISTINCT FROM phase
    OR error->>'code' = 'queue.enqueue_failed'
  );

-- The status and phase checks were unnamed. Drop exactly the two that admit the removed values.
DO $$
DECLARE lifecycle_constraint RECORD;
BEGIN
  FOR lifecycle_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'action_runs'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%''queued''%'
        OR pg_get_constraintdef(oid) LIKE '%''enqueue''%'
      )
  LOOP
    EXECUTE format('ALTER TABLE action_runs DROP CONSTRAINT %I', lifecycle_constraint.conname);
  END LOOP;
END $$;

-- The listing indexes ordered runs by `COALESCE(started_at, queued_at)`.
DROP INDEX idx_action_runs_project_started;
DROP INDEX idx_action_runs_project_action_started;
DROP INDEX idx_action_runs_project_object_started;
DROP INDEX idx_action_runs_project_status_started;

ALTER TABLE action_runs
  DROP COLUMN queued_at,
  ALTER COLUMN phase SET NOT NULL,
  ALTER COLUMN started_at SET NOT NULL,
  ALTER COLUMN finished_at SET NOT NULL,
  ADD CONSTRAINT action_runs_status_check CHECK (status IN ('succeeded', 'failed')),
  ADD CONSTRAINT action_runs_phase_check CHECK (
    phase IN ('validation', 'writeback', 'edits', 'commit', 'effects')
  ),
  ADD CONSTRAINT action_runs_failure_check CHECK ((status = 'failed') = (error IS NOT NULL));

CREATE INDEX idx_action_runs_project_started
  ON action_runs (project_id, started_at DESC);
CREATE INDEX idx_action_runs_project_action_started
  ON action_runs (project_id, action_id, started_at DESC);
CREATE INDEX idx_action_runs_project_object_started
  ON action_runs (project_id, object_type_id, primary_id, started_at DESC);
CREATE INDEX idx_action_runs_project_status_started
  ON action_runs (project_id, status, started_at DESC);
