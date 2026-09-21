ALTER TABLE agent_threads ADD COLUMN sandbox_params TEXT
  CHECK (sandbox_params IS NULL OR (json_valid(sandbox_params) AND json_type(sandbox_params) = 'object'));
ALTER TABLE agent_threads ADD COLUMN workspace_state TEXT
  CHECK (workspace_state IS NULL OR (json_valid(workspace_state) AND json_type(workspace_state) = 'object'));
