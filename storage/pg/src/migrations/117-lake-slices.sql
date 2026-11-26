-- Slices production cut for branches, with the exact files each serves, and the tokens branches
-- read them with. Only the SHA-256 of each token is stored.
CREATE TABLE lake_slices (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  user_id TEXT NOT NULL CHECK (length(trim(user_id)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  point TEXT NOT NULL CHECK (length(trim(point)) > 0),
  versions JSONB NOT NULL CHECK (jsonb_typeof(versions) = 'array'),
  files JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  last_token_expires_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_lake_slices_live
  ON lake_slices (project_id, (coalesce(last_token_expires_at, created_at)));

CREATE TABLE lake_slice_grants (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  slice_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_hash),
  FOREIGN KEY (project_id, slice_id) REFERENCES lake_slices (project_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_lake_slice_grants_expiry ON lake_slice_grants (project_id, expires_at);
