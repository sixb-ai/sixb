-- URLs issued by blobs.createDownloadUrl(). Only the SHA-256 of each URL's token is stored.
CREATE TABLE file_download_grants (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  file JSONB NOT NULL CHECK (jsonb_typeof(file) = 'object'),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_file_download_grants_expiry ON file_download_grants (project_id, expires_at);
