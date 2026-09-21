ALTER TABLE agent_threads ADD COLUMN sandbox_params TEXT
  CHECK (sandbox_params IS NULL OR (json_valid(sandbox_params) AND json_type(sandbox_params) = 'object'));
