-- Agent executions may either use a managed service account or inherit their parent's exact
-- credentialed-user / auth-disabled authority.
ALTER TABLE executions
  DROP CONSTRAINT executions_check3,
  ADD CONSTRAINT executions_agent_authority_check CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS NOT DISTINCT FROM authority_user_id
          AND requested_by_service_account_id IS NOT DISTINCT FROM authority_service_account_id
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
          AND num_nonnulls(authority_session_id, authority_access_token_id) = 1
        )
        OR authority_kind = 'disabled'
      )
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel')
  );

ALTER TABLE agent_runs
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation'
    CHECK (kind IN ('conversation', 'subagent')),
  ADD COLUMN parent_run_id TEXT,
  ADD COLUMN spawn_key TEXT,
  ADD COLUMN spec JSONB,
  ADD COLUMN result JSONB,
  ALTER COLUMN thread_id DROP NOT NULL,
  ALTER COLUMN agent_id DROP NOT NULL,
  ALTER COLUMN trigger_message_id DROP NOT NULL,
  ADD CONSTRAINT fk_agent_runs_parent
    FOREIGN KEY (project_id, parent_run_id)
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT agent_runs_kind_fields CHECK (
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
  ADD CONSTRAINT agent_runs_subagent_result CHECK (
    kind <> 'subagent' OR status <> 'succeeded' OR result IS NOT NULL
  ),
  ADD CONSTRAINT uq_agent_runs_parent_spawn_key UNIQUE (project_id, parent_run_id, spawn_key);

CREATE INDEX idx_agent_runs_project_parent_started
  ON agent_runs (
    project_id,
    parent_run_id,
    status,
    COALESCE(started_at, created_at) DESC,
    id DESC
  );
