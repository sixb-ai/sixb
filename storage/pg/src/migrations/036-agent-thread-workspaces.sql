ALTER TABLE agent_threads ADD COLUMN workspace JSONB
  CHECK (workspace IS NULL OR jsonb_typeof(workspace) = 'object');
