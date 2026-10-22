ALTER TABLE ai_model_call_usage
  ADD COLUMN image_output_tokens INTEGER
  CHECK (image_output_tokens IS NULL OR image_output_tokens >= 0);

ALTER TABLE ai_model_call_usage
  ADD COLUMN audio_output_tokens INTEGER
  CHECK (audio_output_tokens IS NULL OR audio_output_tokens >= 0);

ALTER TABLE ai_model_call_usage
  ADD COLUMN output_images INTEGER
  CHECK (output_images IS NULL OR output_images >= 0);

ALTER TABLE ai_model_call_usage
  ADD COLUMN input_characters INTEGER
  CHECK (input_characters IS NULL OR input_characters >= 0);

-- SQLite cannot alter a CHECK constraint. Swapping the column avoids rebuilding a table that
-- usage groups, costs and limit reservations reference.
ALTER TABLE ai_model_call_usage
  ADD COLUMN model_kind_next TEXT
  CHECK (
    model_kind_next IS NULL
    OR model_kind_next IN (
      'language', 'image', 'video', 'embedding', 'decision', 'transcription', 'speech', 'reranking'
    )
  );

UPDATE ai_model_call_usage SET model_kind_next = model_kind;

ALTER TABLE ai_model_call_usage DROP COLUMN model_kind;

ALTER TABLE ai_model_call_usage RENAME COLUMN model_kind_next TO model_kind;
