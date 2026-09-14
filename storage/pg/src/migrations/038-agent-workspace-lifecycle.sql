ALTER TABLE agent_threads ADD COLUMN workspace_state JSONB
  CHECK (workspace_state IS NULL OR jsonb_typeof(workspace_state) = 'object');
