-- Existing rows cannot be assigned an honest authority retroactively. These NOT NULL additions
-- intentionally fail on non-empty legacy tables instead of inventing execution provenance.
ALTER TABLE agent_runs ADD COLUMN execution_id TEXT NOT NULL;
ALTER TABLE workflow_agent_node_runs ADD COLUMN execution_id TEXT NOT NULL;

CREATE TABLE agent_runs_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  model_id TEXT,
  finish_reason TEXT,
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
  usage_reasoning_tokens INTEGER CHECK (
    usage_reasoning_tokens IS NULL OR usage_reasoning_tokens >= 0
  ),
  usage_cached_input_tokens INTEGER CHECK (
    usage_cached_input_tokens IS NULL OR usage_cached_input_tokens >= 0
  ),
  error TEXT,
  diagnostics TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL))
);

INSERT INTO agent_runs_v2 (
  project_id, id, execution_id, thread_id, agent_id, trigger_message_id, status, model_id,
  finish_reason, usage_input_tokens, usage_output_tokens, usage_total_tokens,
  usage_reasoning_tokens, usage_cached_input_tokens, error, diagnostics, attempt, execution_token,
  execution_queue_lease_expires_at, created_at, started_at, completed_at
)
SELECT
  project_id, id, execution_id, thread_id, agent_id, trigger_message_id, status, model_id,
  finish_reason, usage_input_tokens, usage_output_tokens, usage_total_tokens,
  usage_reasoning_tokens, usage_cached_input_tokens, error, diagnostics, attempt, execution_token,
  execution_queue_lease_expires_at, created_at, started_at, completed_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_v2 RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_project_started
  ON agent_runs(project_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs(project_id, thread_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_agent_started
  ON agent_runs(project_id, agent_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_status_started
  ON agent_runs(project_id, status, COALESCE(started_at, created_at) DESC);

CREATE TABLE workflow_agent_node_runs_v2 (
  project_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  prompt TEXT NOT NULL,
  model_id TEXT,
  finish_reason TEXT,
  usage TEXT,
  trace TEXT,
  diagnostics TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, node_run_id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, node_run_id)
    REFERENCES workflow_node_runs (project_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL))
);

INSERT INTO workflow_agent_node_runs_v2 (
  project_id, node_run_id, execution_id, agent_id, status, prompt, model_id, finish_reason, usage,
  trace, diagnostics, error, attempt, execution_token, execution_queue_lease_expires_at, created_at,
  started_at, completed_at
)
SELECT
  project_id, node_run_id, execution_id, agent_id, status, prompt, model_id, finish_reason, usage,
  trace, diagnostics, error, attempt, execution_token, execution_queue_lease_expires_at, created_at,
  started_at, completed_at
FROM workflow_agent_node_runs;

DROP TABLE workflow_agent_node_runs;
ALTER TABLE workflow_agent_node_runs_v2 RENAME TO workflow_agent_node_runs;

CREATE INDEX idx_workflow_agent_node_runs_project_agent_created
  ON workflow_agent_node_runs(project_id, agent_id, created_at DESC);
CREATE INDEX idx_workflow_agent_node_runs_project_status_created
  ON workflow_agent_node_runs(project_id, status, created_at DESC);
