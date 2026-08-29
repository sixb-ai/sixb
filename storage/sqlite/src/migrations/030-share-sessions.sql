CREATE TABLE share_sessions (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  grant_id TEXT NOT NULL CHECK (length(trim(grant_id)) > 0),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, id, grant_id),
  UNIQUE (project_id, token_hash),
  FOREIGN KEY (project_id, grant_id)
    REFERENCES share_grants (project_id, id),
  CHECK (expires_at > created_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (expires_at <= absolute_expires_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_share_sessions_grant
  ON share_sessions (project_id, grant_id, created_at DESC, id DESC);

CREATE INDEX idx_share_sessions_expiry
  ON share_sessions (project_id, expires_at)
  WHERE revoked_at IS NULL;
