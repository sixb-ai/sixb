ALTER TABLE workflow_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE workflow_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'workflowId', workflow_id,
    'workflowRunId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE workflow_runs DROP COLUMN legacy_error;

ALTER TABLE workflow_node_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_node_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE workflow_node_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'workflowId', workflow_id,
    'workflowRunId', workflow_run_id,
    'nodeId', node_id,
    'nodeRunId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE workflow_node_runs DROP COLUMN legacy_error;
