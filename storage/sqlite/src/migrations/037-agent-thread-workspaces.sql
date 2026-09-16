ALTER TABLE agent_threads ADD COLUMN workspace TEXT
  CHECK (workspace IS NULL OR (json_valid(workspace) AND json_type(workspace) = 'object'));
