-- SQLite cannot alter a CHECK constraint in place. Rebuild the execution table to align SQL with
-- the durable Agent authority model: managed service account or exact inherited user/disabled.
CREATE TABLE executions_v3 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  executor_kind TEXT NOT NULL CHECK (
    executor_kind IN (
      'request', 'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow',
      'agent', 'kernel'
    )
  ),
  executor_id TEXT NOT NULL CHECK (length(trim(executor_id)) > 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution')
  ),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  requested_by_user_id TEXT,
  requested_by_service_account_id TEXT,
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  parent_execution_id TEXT,
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'kernel', 'disabled')
  ),
  authority_user_id TEXT,
  authority_service_account_id TEXT,
  authority_session_id TEXT,
  authority_access_token_id TEXT,
  authority_primitive_kind TEXT CHECK (
    authority_primitive_kind IS NULL
      OR authority_primitive_kind IN (
        'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow'
      )
  ),
  authority_primitive_id TEXT,
  authority_kernel_operation TEXT CHECK (
    authority_kernel_operation IS NULL OR authority_kernel_operation = 'ontology.recover'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_execution_id) REFERENCES executions (project_id, id),
  FOREIGN KEY (project_id, requested_by_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, requested_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, authority_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_session_id) REFERENCES auth_sessions (project_id, id),
  FOREIGN KEY (project_id, authority_access_token_id)
    REFERENCES auth_access_tokens (project_id, id),
  CHECK ((requested_by_user_id IS NOT NULL) + (requested_by_service_account_id IS NOT NULL) <= 1),
  CHECK (
    (source_kind = 'execution' AND parent_execution_id = source_id)
      OR (source_kind <> 'execution' AND parent_execution_id IS NULL)
  ),
  CHECK (
    (
      authority_kind = 'principal'
      AND (authority_user_id IS NOT NULL) + (authority_service_account_id IS NOT NULL) = 1
      AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) <= 1
      AND (authority_session_id IS NULL OR authority_user_id IS NOT NULL)
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
    )
    OR (
      authority_kind = 'trustedPrimitive'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NOT NULL
      AND authority_primitive_id IS NOT NULL
      AND length(trim(authority_primitive_id)) > 0
      AND authority_kernel_operation IS NULL
    )
    OR (
      authority_kind = 'kernel'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NOT NULL
    )
    OR (
      authority_kind = 'disabled'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
    )
  ),
  CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS authority_user_id
          AND requested_by_service_account_id IS authority_service_account_id
        )
        OR (
          authority_kind = 'disabled'
          AND requested_by_user_id IS NULL
          AND requested_by_service_account_id IS NULL
        )
      )
    )
    OR (
      executor_kind IN ('action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow')
      AND authority_kind = 'trustedPrimitive'
      AND executor_kind = authority_primitive_kind
    )
    OR (
      executor_kind = 'agent'
      AND source_kind = 'execution'
      AND (
        (
          authority_kind = 'principal'
          AND authority_service_account_id IS NOT NULL
          AND authority_session_id IS NULL
          AND authority_access_token_id IS NULL
        )
        OR (
          authority_kind = 'principal'
          AND authority_user_id IS NOT NULL
          AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) = 1
        )
        OR authority_kind = 'disabled'
      )
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel')
  )
);

INSERT INTO executions_v3 SELECT * FROM executions;
DROP TABLE executions;
ALTER TABLE executions_v3 RENAME TO executions;

CREATE TABLE agent_runs_v3 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'conversation' CHECK (kind IN ('conversation', 'subagent')),
  thread_id TEXT,
  agent_id TEXT,
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
    REFERENCES agent_runs_v3 (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)),
  CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
      AND spec IS NULL
      AND result IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND thread_id IS NULL
      AND agent_id IS NULL
      AND trigger_message_id IS NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND spec IS NOT NULL
    )
  ),
  CHECK (kind <> 'subagent' OR status <> 'succeeded' OR result IS NOT NULL)
);

INSERT INTO agent_runs_v3 (
  project_id, id, execution_id, kind, thread_id, agent_id, trigger_message_id,
  requester_group_ids, status, model_id, finish_reason, error, diagnostics, attempt,
  execution_token, execution_queue_lease_expires_at, created_at, started_at, completed_at
)
SELECT
  project_id, id, execution_id, 'conversation', thread_id, agent_id, trigger_message_id,
  requester_group_ids, status, model_id, finish_reason, error, diagnostics, attempt,
  execution_token, execution_queue_lease_expires_at, created_at, started_at, completed_at
FROM agent_runs;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_v3 RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_project_started
  ON agent_runs(project_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs(project_id, thread_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_agent_started
  ON agent_runs(project_id, agent_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_status_started
  ON agent_runs(project_id, status, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_parent_started
  ON agent_runs(project_id, parent_run_id, status, COALESCE(started_at, created_at) DESC);
