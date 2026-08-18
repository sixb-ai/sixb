ALTER TABLE agent_runs
  ADD COLUMN requester_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_requester_group_ids_array
  CHECK (jsonb_typeof(requester_group_ids) = 'array');

ALTER TABLE workflow_runs
  ADD COLUMN requester_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_requester_group_ids_array
  CHECK (jsonb_typeof(requester_group_ids) = 'array');

CREATE TABLE ai_model_call_usage (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  attempt BIGINT NOT NULL CHECK (attempt >= 1),
  call_id TEXT NOT NULL CHECK (length(trim(call_id)) > 0),
  provider_id TEXT NOT NULL CHECK (length(trim(provider_id)) > 0),
  requested_model_id TEXT NOT NULL CHECK (length(trim(requested_model_id)) > 0),
  response_model_id TEXT CHECK (
    response_model_id IS NULL OR length(trim(response_model_id)) > 0
  ),
  response_id TEXT NOT NULL CHECK (length(trim(response_id)) > 0),
  input_tokens BIGINT CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens BIGINT CHECK (total_tokens IS NULL OR total_tokens >= 0),
  uncached_input_tokens BIGINT CHECK (
    uncached_input_tokens IS NULL OR uncached_input_tokens >= 0
  ),
  cache_read_input_tokens BIGINT CHECK (
    cache_read_input_tokens IS NULL OR cache_read_input_tokens >= 0
  ),
  cache_write_input_tokens BIGINT CHECK (
    cache_write_input_tokens IS NULL OR cache_write_input_tokens >= 0
  ),
  text_output_tokens BIGINT CHECK (
    text_output_tokens IS NULL OR text_output_tokens >= 0
  ),
  reasoning_output_tokens BIGINT CHECK (
    reasoning_output_tokens IS NULL OR reasoning_output_tokens >= 0
  ),
  reporting_status TEXT NOT NULL CHECK (
    reporting_status IN ('complete', 'partial', 'unavailable')
  ),
  raw_usage JSONB CHECK (raw_usage IS NULL OR jsonb_typeof(raw_usage) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions(project_id, id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_ai_model_call_usage_idempotency
  ON ai_model_call_usage (project_id, execution_id, attempt, call_id, response_id);
CREATE INDEX idx_ai_model_call_usage_execution
  ON ai_model_call_usage (project_id, execution_id, occurred_at, id);
CREATE INDEX idx_ai_model_call_usage_project_time
  ON ai_model_call_usage (project_id, occurred_at, id);
CREATE INDEX idx_ai_model_call_usage_provider_response
  ON ai_model_call_usage (project_id, provider_id, response_id);

CREATE TABLE ai_model_call_usage_groups (
  project_id TEXT NOT NULL,
  usage_record_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, usage_record_id, group_id),
  FOREIGN KEY (project_id, usage_record_id)
    REFERENCES ai_model_call_usage(project_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_ai_model_call_usage_groups_group_time
  ON ai_model_call_usage_groups (project_id, group_id, occurred_at, usage_record_id);
