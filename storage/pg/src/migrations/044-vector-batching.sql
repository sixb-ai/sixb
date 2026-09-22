ALTER TABLE object_vector_indexing ADD COLUMN batch_id TEXT;
CREATE INDEX object_vector_indexing_batch ON object_vector_indexing (project_id, batch_id, id)
  WHERE batch_id IS NOT NULL;
