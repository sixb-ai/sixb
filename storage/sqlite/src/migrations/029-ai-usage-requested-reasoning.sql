ALTER TABLE ai_model_call_usage
  ADD COLUMN requested_reasoning TEXT
  CHECK (
    requested_reasoning IS NULL OR (
      json_valid(requested_reasoning) AND
      json_type(requested_reasoning) IN ('text', 'object')
    )
  );
