-- Preserve the claim order without sorting every pending event for each batch.
-- Keep the availability index for selective delayed/leased workloads.
CREATE INDEX idx_ontology_outbox_publication_order
  ON ontology_outbox (project_id, created_at, commit_id, commit_ordinal)
  WHERE published_at IS NULL;
