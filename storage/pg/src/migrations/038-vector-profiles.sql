-- Transactional derived state. Search extensions are not required for persistence.
CREATE TABLE object_vectors (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (length(btrim(profile)) > 0),
  configuration TEXT NOT NULL,
  source TEXT[] NOT NULL,
  source_fingerprint TEXT NOT NULL,
  embedding REAL[] NOT NULL,
  last_commit_id TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, primary_id, profile),
  FOREIGN KEY (project_id, object_type_id, primary_id)
    REFERENCES objects (project_id, object_type_id, primary_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, last_commit_id)
    REFERENCES ontology_commits (project_id, id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT object_vectors_sources CHECK (
    cardinality(source) > 0 AND array_ndims(source) = 1 AND array_lower(source, 1) = 1
    AND array_position(source, NULL) IS NULL
  ),
  CONSTRAINT object_vectors_values CHECK (
    cardinality(embedding) BETWEEN 1 AND 16000
    AND array_ndims(embedding) = 1 AND array_lower(embedding, 1) = 1
    AND array_position(embedding, NULL) IS NULL
    AND '-Infinity'::real < ALL(embedding) AND 'Infinity'::real > ALL(embedding)
    AND 0::real <> ANY(embedding)
  )
);
