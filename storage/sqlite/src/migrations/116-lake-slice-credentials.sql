-- A branch's credential: it reads production only as its slice's person, only for the branch.
-- Only its SHA-256 is stored.
ALTER TABLE lake_slices ADD COLUMN credential_hash TEXT
  CHECK (credential_hash IS NULL OR (length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'));

CREATE UNIQUE INDEX idx_lake_slices_credential
  ON lake_slices (project_id, credential_hash) WHERE credential_hash IS NOT NULL;
