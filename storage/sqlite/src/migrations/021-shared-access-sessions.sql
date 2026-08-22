CREATE TABLE share_sessions (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  grant_id TEXT NOT NULL CHECK (length(trim(grant_id)) > 0),
  token_digest TEXT NOT NULL CHECK (length(trim(token_digest)) > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_digest),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_share_sessions_grant
  ON share_sessions (project_id, grant_id, expires_at)
  WHERE revoked_at IS NULL;
