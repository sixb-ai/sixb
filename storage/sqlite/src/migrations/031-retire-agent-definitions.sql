DROP INDEX idx_agent_threads_project_agent_activity;
ALTER TABLE workflow_agent_node_runs RENAME COLUMN agent_id TO actor_id;
ALTER TABLE agent_threads DROP COLUMN agent_id;

CREATE TABLE agent_runs_v5 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'conversation' CHECK (kind IN ('conversation', 'subagent')),
  thread_id TEXT,
  trigger_message_id TEXT,
  parent_run_id TEXT,
  spawn_key TEXT,
  spec TEXT CHECK (spec IS NULL OR json_valid(spec)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  requester_group_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(requester_group_ids) AND json_type(requester_group_ids) = 'array'),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  model_id TEXT,
  finish_reason TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  diagnostics TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  UNIQUE (project_id, parent_run_id, spawn_key),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_run_id)
    -- Use the final name: Bun's legacy ALTER mode preserves references when foreign keys are off.
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)),
  CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
      AND result IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND thread_id IS NULL
      AND trigger_message_id IS NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND spec IS NOT NULL
    )
  ),
  CHECK (kind <> 'subagent' OR status <> 'succeeded' OR result IS NOT NULL)
);

INSERT INTO agent_runs_v5 (
  project_id, id, execution_id, kind, thread_id, trigger_message_id, parent_run_id, spawn_key,
  spec, result, requester_group_ids, status, model_id, finish_reason, error, diagnostics, attempt,
  execution_token, execution_queue_lease_expires_at, created_at, started_at, completed_at
)
SELECT
  project_id, id, execution_id, kind, thread_id, trigger_message_id, parent_run_id, spawn_key,
  spec, result, requester_group_ids, status, model_id, finish_reason, error, diagnostics, attempt,
  execution_token, execution_queue_lease_expires_at, created_at, started_at, completed_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_v5 RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs (project_id, thread_id, COALESCE(started_at, created_at) DESC, id DESC);
CREATE INDEX idx_agent_runs_project_status_created
  ON agent_runs (project_id, status, created_at, id);
CREATE INDEX idx_agent_runs_project_parent_started
  ON agent_runs (
    project_id,
    parent_run_id,
    status,
    COALESCE(started_at, created_at) DESC,
    id DESC
  );
