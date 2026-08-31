ALTER TABLE ai_model_call_usage ADD COLUMN model_definition TEXT
  CHECK (
    model_definition IS NULL OR
    (json_valid(model_definition) AND json_type(model_definition) = 'object')
  );
ALTER TABLE ai_model_call_usage ADD COLUMN cost TEXT
  CHECK (cost IS NULL OR (json_valid(cost) AND json_type(cost) = 'object'));
ALTER TABLE ai_model_call_usage ADD COLUMN route TEXT
  CHECK (route IS NULL OR (json_valid(route) AND json_type(route) = 'object'));
