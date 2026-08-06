ALTER TABLE projection_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE projection_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'projectionId', projection_id,
    'runId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE error_message IS NOT NULL;

ALTER TABLE projection_runs DROP COLUMN error_message;
