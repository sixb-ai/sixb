ALTER TABLE workflow_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_runs ADD COLUMN error JSONB;

UPDATE workflow_runs
SET error = jsonb_build_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(COALESCE(finished_at, started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'workflowId', workflow_id,
    'workflowRunId', id,
    'migratedFromLegacyError', true
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE workflow_runs DROP COLUMN legacy_error;

ALTER TABLE workflow_node_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_node_runs ADD COLUMN error JSONB;

UPDATE workflow_node_runs
SET error = jsonb_build_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(COALESCE(finished_at, started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'workflowId', workflow_id,
    'workflowRunId', workflow_run_id,
    'nodeId', node_id,
    'nodeRunId', id,
    'migratedFromLegacyError', true
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE workflow_node_runs DROP COLUMN legacy_error;
