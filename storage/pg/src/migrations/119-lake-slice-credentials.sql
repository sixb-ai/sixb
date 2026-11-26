-- A branch's credential: it reads production only as its slice's person, only for the branch.
-- Only its SHA-256 is stored.
ALTER TABLE lake_slices ADD COLUMN credential_hash TEXT
  CHECK (credential_hash IS NULL OR credential_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX idx_lake_slices_credential
  ON lake_slices (project_id, credential_hash) WHERE credential_hash IS NOT NULL;

-- The groups the copy read with, which an access token may narrow: the credential reads with no more.
ALTER TABLE lake_slices ADD COLUMN credential_group_ids JSONB;

-- What the person signed in with to take the copy: the credential reads nothing once that session
-- is signed out or that access token revoked. Both or neither.
ALTER TABLE lake_slices ADD COLUMN credential_minted_by_type TEXT
  CHECK (credential_minted_by_type IN ('session', 'accessToken'));
ALTER TABLE lake_slices ADD COLUMN credential_minted_by_id TEXT;
ALTER TABLE lake_slices ADD CONSTRAINT lake_slices_credential_minted_by
  CHECK ((credential_minted_by_type IS NULL) = (credential_minted_by_id IS NULL));

-- When the branch confirmed it holds its copy whole: a copy no branch confirmed lives a short grace.
ALTER TABLE lake_slices ADD COLUMN received_at TIMESTAMPTZ;
