ALTER TABLE agent_runs
  ADD COLUMN requester_group_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(requester_group_ids) AND json_type(requester_group_ids) = 'array');

ALTER TABLE workflow_runs
  ADD COLUMN requester_group_ids TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(requester_group_ids) AND json_type(requester_group_ids) = 'array');

CREATE TABLE ai_model_call_usage (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_kind TEXT NOT NULL CHECK (
    execution_kind IN ('agentRun', 'workflowAgentNode')
  ),
  agent_run_id TEXT,
  workflow_run_id TEXT,
  workflow_node_run_id TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  call_id TEXT NOT NULL,
  requester_principal_type TEXT NOT NULL CHECK (
    requester_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  requester_principal_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  requested_model_id TEXT NOT NULL,
  response_model_id TEXT,
  response_id TEXT NOT NULL,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  uncached_input_tokens INTEGER CHECK (
    uncached_input_tokens IS NULL OR uncached_input_tokens >= 0
  ),
  cache_read_input_tokens INTEGER CHECK (
    cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0
  ),
  cache_write_input_tokens INTEGER CHECK (
    cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0
  ),
  text_output_tokens INTEGER CHECK (
    text_output_tokens IS NULL OR text_output_tokens >= 0
  ),
  reasoning_output_tokens INTEGER CHECK (
    reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0
  ),
  reporting_status TEXT NOT NULL CHECK (
    reporting_status IN ('complete', 'partial', 'unavailable')
  ),
  raw_usage TEXT CHECK (raw_usage IS NULL OR json_valid(raw_usage)),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  CHECK (
    (
      execution_kind = 'agentRun'
      AND agent_run_id IS NOT NULL
      AND workflow_run_id IS NULL
      AND workflow_node_run_id IS NULL
    ) OR (
      execution_kind = 'workflowAgentNode'
      AND agent_run_id IS NULL
      AND workflow_run_id IS NOT NULL
      AND workflow_node_run_id IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX idx_ai_model_call_usage_agent_idempotency
  ON ai_model_call_usage (project_id, agent_run_id, attempt, call_id, response_id)
  WHERE execution_kind = 'agentRun';
CREATE UNIQUE INDEX idx_ai_model_call_usage_workflow_idempotency
  ON ai_model_call_usage (
    project_id,
    workflow_run_id,
    workflow_node_run_id,
    attempt,
    call_id,
    response_id
  )
  WHERE execution_kind = 'workflowAgentNode';
CREATE INDEX idx_ai_model_call_usage_agent_execution
  ON ai_model_call_usage (project_id, agent_run_id, occurred_at, id)
  WHERE execution_kind = 'agentRun';
CREATE INDEX idx_ai_model_call_usage_workflow_execution
  ON ai_model_call_usage (
    project_id,
    workflow_run_id,
    workflow_node_run_id,
    occurred_at,
    id
  )
  WHERE execution_kind = 'workflowAgentNode';
CREATE INDEX idx_ai_model_call_usage_project_time
  ON ai_model_call_usage (project_id, occurred_at, id);
CREATE INDEX idx_ai_model_call_usage_principal_time
  ON ai_model_call_usage (
    project_id,
    requester_principal_type,
    requester_principal_id,
    occurred_at,
    id
  );
CREATE INDEX idx_ai_model_call_usage_provider_response
  ON ai_model_call_usage (project_id, provider_id, response_id);

CREATE TABLE ai_model_call_usage_groups (
  project_id TEXT NOT NULL,
  usage_record_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY (project_id, usage_record_id, group_id),
  FOREIGN KEY (project_id, usage_record_id)
    REFERENCES ai_model_call_usage(project_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_ai_model_call_usage_groups_group_time
  ON ai_model_call_usage_groups (project_id, group_id, occurred_at, usage_record_id);
