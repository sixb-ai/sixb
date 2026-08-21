ALTER TABLE agent_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE agent_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE agent_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(completed_at, started_at, created_at),
  'details', json_object(
    'agentId', agent_id,
    'runId', id,
    'threadId', thread_id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE agent_runs DROP COLUMN legacy_error;

ALTER TABLE workflow_agent_node_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_agent_node_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE workflow_agent_node_runs
SET error = json_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', json('false'),
  'at', COALESCE(completed_at, started_at, created_at),
  'details', json_object(
    'agentId', agent_id,
    'workflowId', (
      SELECT workflow_id FROM workflow_node_runs AS node
      WHERE node.project_id = workflow_agent_node_runs.project_id
        AND node.id = workflow_agent_node_runs.node_run_id
    ),
    'workflowRunId', (
      SELECT workflow_run_id FROM workflow_node_runs AS node
      WHERE node.project_id = workflow_agent_node_runs.project_id
        AND node.id = workflow_agent_node_runs.node_run_id
    ),
    'nodeId', (
      SELECT node_id FROM workflow_node_runs AS node
      WHERE node.project_id = workflow_agent_node_runs.project_id
        AND node.id = workflow_agent_node_runs.node_run_id
    ),
    'nodeRunId', node_run_id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE workflow_agent_node_runs DROP COLUMN legacy_error;
