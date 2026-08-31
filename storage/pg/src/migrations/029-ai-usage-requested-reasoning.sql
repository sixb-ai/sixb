ALTER TABLE ai_model_call_usage
  ADD COLUMN requested_reasoning JSONB
  CHECK (
    requested_reasoning IS NULL OR
    jsonb_typeof(requested_reasoning) IN ('string', 'object')
  );
