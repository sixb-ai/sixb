CREATE TABLE share_sessions (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  grant_id TEXT NOT NULL CHECK (length(trim(grant_id)) > 0),
  token_digest TEXT NOT NULL CHECK (length(trim(token_digest)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_digest),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX idx_share_sessions_grant
  ON share_sessions (project_id, grant_id, expires_at)
  WHERE revoked_at IS NULL;
