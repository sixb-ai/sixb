ALTER TABLE agent_threads ADD COLUMN workspace_state TEXT
  CHECK (workspace_state IS NULL OR json_type(workspace_state) = 'object');
