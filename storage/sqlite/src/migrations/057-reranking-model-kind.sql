-- SQLite cannot alter a CHECK constraint. Swapping the column avoids rebuilding a table that
-- usage groups, costs and limit reservations reference.
ALTER TABLE ai_model_call_usage
  ADD COLUMN model_kind_next TEXT
  CHECK (
    model_kind_next IS NULL
    OR model_kind_next IN (
      'language', 'image', 'video', 'embedding', 'decision', 'transcription', 'reranking'
    )
  );

UPDATE ai_model_call_usage SET model_kind_next = model_kind;

ALTER TABLE ai_model_call_usage DROP COLUMN model_kind;

ALTER TABLE ai_model_call_usage RENAME COLUMN model_kind_next TO model_kind;
