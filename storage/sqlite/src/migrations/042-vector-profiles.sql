CREATE TABLE object_vectors (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (length(trim(profile)) > 0),
  configuration TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    json_valid(source) AND json_type(source) = 'array' AND json_array_length(source) > 0
  ),
  source_fingerprint TEXT NOT NULL,
  embedding BLOB NOT NULL CHECK (
    typeof(embedding) = 'blob' AND length(embedding) BETWEEN 4 AND 64000
    AND length(embedding) % 4 = 0
  ),
  last_commit_id TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, primary_id, profile),
  FOREIGN KEY (project_id, object_type_id, primary_id)
    REFERENCES objects (project_id, object_type_id, primary_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, last_commit_id)
    REFERENCES ontology_commits (project_id, id) DEFERRABLE INITIALLY DEFERRED
);
