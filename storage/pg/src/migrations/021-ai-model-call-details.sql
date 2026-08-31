ALTER TABLE ai_model_call_usage ADD COLUMN model_definition JSONB
  CHECK (model_definition IS NULL OR jsonb_typeof(model_definition) = 'object');
ALTER TABLE ai_model_call_usage ADD COLUMN cost JSONB
  CHECK (cost IS NULL OR jsonb_typeof(cost) = 'object');
ALTER TABLE ai_model_call_usage ADD COLUMN route JSONB
  CHECK (route IS NULL OR jsonb_typeof(route) = 'object');
