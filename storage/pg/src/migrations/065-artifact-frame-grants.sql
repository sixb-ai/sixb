-- Short-lived links that a sandboxed frame loads a deck's files through. Only the SHA-256 of each
-- link's token is stored.
CREATE TABLE artifact_frame_grants (
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, token_hash),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_artifact_frame_grants_expiry ON artifact_frame_grants (project_id, expires_at);
