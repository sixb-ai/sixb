DROP INDEX IF EXISTS idx_agent_threads_project_agent_activity;
ALTER TABLE workflow_agent_node_runs RENAME COLUMN agent_id TO actor_id;
DROP INDEX IF EXISTS idx_agent_runs_project_agent_started;

ALTER TABLE agent_threads DROP COLUMN agent_id;

ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_kind_fields,
  DROP COLUMN agent_id,
  ADD CONSTRAINT agent_runs_kind_fields CHECK (
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
  );
