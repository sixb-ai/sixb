ALTER TABLE pipeline_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE pipeline_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'pipelineId', pipeline_id,
    'runId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE pipeline_runs DROP COLUMN error_name;
ALTER TABLE pipeline_runs DROP COLUMN error_message;

ALTER TABLE pipeline_step_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE pipeline_step_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'pipelineId', pipeline_id,
    'pipelineRunId', pipeline_run_id,
    'stepId', step_id,
    'stepRunId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE error_name IS NOT NULL OR error_message IS NOT NULL;

ALTER TABLE pipeline_step_runs DROP COLUMN error_name;
ALTER TABLE pipeline_step_runs DROP COLUMN error_message;
