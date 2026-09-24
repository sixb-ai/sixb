ALTER TABLE agent_threads ADD COLUMN sandbox_state TEXT
  CHECK (sandbox_state IS NULL OR (json_valid(sandbox_state) AND json_type(sandbox_state) = 'object'));
