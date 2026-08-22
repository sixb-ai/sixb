ALTER TABLE projection_runs ADD COLUMN error JSONB;

UPDATE projection_runs
SET error = jsonb_build_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(COALESCE(finished_at, started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'projectionId', projection_id,
    'runId', id,
    'migratedFromLegacyError', true
  )
)
WHERE error_message IS NOT NULL;

ALTER TABLE projection_runs DROP COLUMN error_message;
