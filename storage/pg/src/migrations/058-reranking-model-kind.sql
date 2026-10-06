ALTER TABLE ai_model_call_usage
  DROP CONSTRAINT ai_model_call_usage_model_kind_check;

ALTER TABLE ai_model_call_usage
  ADD CONSTRAINT ai_model_call_usage_model_kind_check
  CHECK (
    model_kind IS NULL
    OR model_kind IN (
      'language', 'image', 'video', 'embedding', 'decision', 'transcription', 'reranking'
    )
  );
