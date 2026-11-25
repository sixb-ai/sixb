-- Slices production cut for branches, with the exact files each serves, and the tokens branches
-- read them with. Only the SHA-256 of each token is stored. Timestamps are ISO-8601 UTC text.
CREATE TABLE lake_slices (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  point TEXT NOT NULL CHECK (length(trim(point)) > 0),
  versions TEXT NOT NULL CHECK (json_type(versions) = 'array'),
  files TEXT NOT NULL CHECK (json_type(files) = 'array'),
  created_at TEXT NOT NULL,
  last_token_expires_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE lake_slice_grants (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  slice_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_hash),
  FOREIGN KEY (project_id, slice_id) REFERENCES lake_slices (project_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_lake_slice_grants_expiry ON lake_slice_grants (project_id, expires_at);
