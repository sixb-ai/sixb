-- URLs issued by blobs.createDownloadUrl(). Only the SHA-256 of each URL's token is stored.
-- Timestamps are ISO-8601 UTC text and compare lexicographically.
CREATE TABLE file_download_grants (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  file TEXT NOT NULL CHECK (json_type(file) = 'object'),
  execution_id TEXT NOT NULL CHECK (length(trim(execution_id)) > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_file_download_grants_expiry ON file_download_grants (project_id, expires_at);
