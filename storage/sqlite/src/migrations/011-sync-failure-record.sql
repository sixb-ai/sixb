ALTER TABLE sync_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE sync_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'syncId', sync_id,
    'runId', id,
    'datasetId', dataset_id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE sync_runs DROP COLUMN error_name;
ALTER TABLE sync_runs DROP COLUMN error_message;
