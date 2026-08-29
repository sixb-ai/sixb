CREATE TABLE share_grants (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  definition_id TEXT NOT NULL CHECK (length(trim(definition_id)) > 0),
  target_object_type_id TEXT NOT NULL CHECK (length(trim(target_object_type_id)) > 0),
  target_primary_id TEXT NOT NULL CHECK (length(trim(target_primary_id)) > 0),
  issued_by_type TEXT NOT NULL CHECK (issued_by_type IN ('user', 'serviceAccount')),
  issued_by_id TEXT NOT NULL CHECK (length(trim(issued_by_id)) > 0),
  authority_version INTEGER NOT NULL CHECK (authority_version > 0),
  authority_snapshot JSONB NOT NULL CHECK (
    jsonb_typeof(authority_snapshot) = 'object'
    AND jsonb_typeof(authority_snapshot -> 'version') = 'number'
    AND (authority_snapshot ->> 'version')::integer = authority_version
    AND jsonb_typeof(authority_snapshot -> 'access') = 'object'
  ),
  authority_digest TEXT NOT NULL CHECK (authority_digest ~ '^[0-9a-f]{64}$'),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  destination_path TEXT NOT NULL CHECK (
    left(destination_path, 1) = '/'
    AND position('?' IN destination_path) = 0
    AND position('#' IN destination_path) = 0
    AND position(chr(92) IN destination_path) = 0
  ),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_by_type TEXT CHECK (
    revoked_by_type IS NULL OR revoked_by_type IN ('user', 'serviceAccount', 'system')
  ),
  revoked_by_id TEXT CHECK (
    revoked_by_id IS NULL OR length(trim(revoked_by_id)) > 0
  ),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_hash),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by_type IS NULL AND revoked_by_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by_type IS NOT NULL AND revoked_by_id IS NOT NULL)
  )
);

CREATE INDEX idx_share_grants_project_created
  ON share_grants (project_id, created_at DESC, id DESC);
CREATE INDEX idx_share_grants_definition_target
  ON share_grants (
    project_id,
    definition_id,
    target_object_type_id,
    target_primary_id,
    created_at DESC,
    id DESC
  );
CREATE INDEX idx_share_grants_expiry
  ON share_grants (project_id, expires_at)
  WHERE revoked_at IS NULL;
