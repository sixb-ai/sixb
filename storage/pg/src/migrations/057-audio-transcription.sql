ALTER TABLE ai_model_call_usage
  ADD COLUMN audio_duration_ms BIGINT
  CHECK (audio_duration_ms IS NULL OR audio_duration_ms >= 0);

ALTER TABLE ai_model_call_usage
  ADD COLUMN model_kind TEXT
  CHECK (
    model_kind IS NULL
    OR model_kind IN ('language', 'image', 'video', 'embedding', 'decision', 'transcription')
  );
