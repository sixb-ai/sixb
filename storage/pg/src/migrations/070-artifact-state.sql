-- What a page keeps for each of its readers with `sixb.state`: JSON text by key, for one artifact
-- and one principal, across the artifact's versions. The value stays text, as written, so its
-- size is the one the reader's limits count; `size_bytes` is its UTF-8 length. Deleting the
-- artifact cascades here.
CREATE TABLE artifact_state (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'serviceAccount', 'system')),
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  key TEXT NOT NULL CHECK (length(key) > 0),
  value TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, artifact_id, principal_type, principal_id, key),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE
);
