ALTER TABLE ai_model_call_usage
  ADD COLUMN image_output_tokens BIGINT
  CHECK (image_output_tokens IS NULL OR image_output_tokens >= 0),
  ADD COLUMN audio_output_tokens BIGINT
  CHECK (audio_output_tokens IS NULL OR audio_output_tokens >= 0),
  ADD COLUMN output_images BIGINT
  CHECK (output_images IS NULL OR output_images >= 0),
  ADD COLUMN input_characters BIGINT
  CHECK (input_characters IS NULL OR input_characters >= 0);

ALTER TABLE ai_model_call_usage
  DROP CONSTRAINT ai_model_call_usage_model_kind_check;

ALTER TABLE ai_model_call_usage
  ADD CONSTRAINT ai_model_call_usage_model_kind_check
  CHECK (
    model_kind IS NULL
    OR model_kind IN (
      'language', 'image', 'video', 'embedding', 'decision', 'transcription', 'speech', 'reranking'
    )
  );
