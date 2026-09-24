ALTER TABLE agent_threads ADD COLUMN sandbox_state JSONB
  CHECK (sandbox_state IS NULL OR jsonb_typeof(sandbox_state) = 'object');
