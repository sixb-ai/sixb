ALTER TABLE agent_threads ADD COLUMN sandbox_params JSONB
  CHECK (sandbox_params IS NULL OR jsonb_typeof(sandbox_params) = 'object');
ALTER TABLE agent_threads ADD COLUMN workspace_state JSONB
  CHECK (workspace_state IS NULL OR jsonb_typeof(workspace_state) = 'object');
