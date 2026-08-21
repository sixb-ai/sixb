ALTER TABLE sync_runs ADD COLUMN error JSONB;

UPDATE sync_runs
SET error = jsonb_build_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(COALESCE(finished_at, started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'syncId', sync_id,
    'runId', id,
    'datasetId', dataset_id,
    'migratedFromLegacyError', true
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE sync_runs
  DROP COLUMN error_name,
  DROP COLUMN error_message;
