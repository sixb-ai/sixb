-- A branch's credential: it reads production only as its slice's person, only for the branch.
-- Only its SHA-256 is stored.
ALTER TABLE lake_slices ADD COLUMN credential_hash TEXT
  CHECK (credential_hash IS NULL OR credential_hash ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX idx_lake_slices_credential
  ON lake_slices (project_id, credential_hash) WHERE credential_hash IS NOT NULL;
