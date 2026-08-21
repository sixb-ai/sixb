ALTER TABLE agent_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE agent_runs ADD COLUMN error JSONB;

UPDATE agent_runs
SET error = jsonb_build_object(
  'code', CASE WHEN status = 'cancelled' THEN 'runtime.cancelled' ELSE 'internal.unexpected' END,
  'message', CASE
    WHEN status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(COALESCE(completed_at, started_at, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'agentId', agent_id,
    'runId', id,
    'threadId', thread_id,
    'migratedFromLegacyError', true
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE agent_runs DROP COLUMN legacy_error;

ALTER TABLE workflow_agent_node_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE workflow_agent_node_runs ADD COLUMN error JSONB;

UPDATE workflow_agent_node_runs AS agent_node
SET error = jsonb_build_object(
  'code', CASE
    WHEN agent_node.status = 'cancelled' THEN 'runtime.cancelled'
    ELSE 'internal.unexpected'
  END,
  'message', CASE
    WHEN agent_node.status = 'cancelled' THEN 'Execution was cancelled.'
    ELSE 'An unexpected internal error occurred.'
  END,
  'retryable', false,
  'at', to_char(
    COALESCE(agent_node.completed_at, agent_node.started_at, agent_node.created_at) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  'details', jsonb_build_object(
    'agentId', agent_node.agent_id,
    'workflowId', node.workflow_id,
    'workflowRunId', node.workflow_run_id,
    'nodeId', node.node_id,
    'nodeRunId', agent_node.node_run_id,
    'migratedFromLegacyError', true
  )
)
FROM workflow_node_runs AS node
WHERE node.project_id = agent_node.project_id
  AND node.id = agent_node.node_run_id
  AND agent_node.legacy_error IS NOT NULL;

ALTER TABLE workflow_agent_node_runs DROP COLUMN legacy_error;
