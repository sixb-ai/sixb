ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_kind_fields,
  ADD CONSTRAINT agent_runs_kind_fields CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND agent_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
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
  );
