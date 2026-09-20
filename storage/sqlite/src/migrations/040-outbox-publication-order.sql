-- Match the bounded claim order without sorting the entire unpublished backlog.
-- Cover every selection predicate so new databases also benefit before ANALYZE.
CREATE INDEX idx_ontology_outbox_publication_order
  ON ontology_outbox(
    project_id, published_at, created_at, commit_id, commit_ordinal,
    available_at, lease_expires_at
  )
  WHERE published_at IS NULL;
