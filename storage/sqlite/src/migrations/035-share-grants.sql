CREATE TABLE share_grants (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  definition_id TEXT NOT NULL CHECK (length(trim(definition_id)) > 0),
  target_object_type_id TEXT NOT NULL CHECK (length(trim(target_object_type_id)) > 0),
  target_primary_id TEXT NOT NULL CHECK (length(trim(target_primary_id)) > 0),
  issued_by_type TEXT NOT NULL CHECK (issued_by_type IN ('user', 'serviceAccount')),
  issued_by_id TEXT NOT NULL CHECK (length(trim(issued_by_id)) > 0),
  authority_version INTEGER NOT NULL CHECK (authority_version > 0),
  authority_snapshot TEXT NOT NULL CHECK (
    json_valid(authority_snapshot)
    AND json_type(authority_snapshot) = 'object'
    AND json_type(authority_snapshot, '$.version') = 'integer'
    AND json_extract(authority_snapshot, '$.version') = authority_version
    AND json_type(authority_snapshot, '$.access') = 'object'
  ),
  authority_digest TEXT NOT NULL CHECK (
    length(authority_digest) = 64
    AND authority_digest = lower(authority_digest)
    AND authority_digest NOT GLOB '*[^0-9a-f]*'
  ),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64
    AND token_hash = lower(token_hash)
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  destination_path TEXT NOT NULL CHECK (
    substr(destination_path, 1, 1) = '/'
    AND instr(destination_path, '?') = 0
    AND instr(destination_path, '#') = 0
    AND instr(destination_path, char(92)) = 0
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_type TEXT CHECK (
    revoked_by_type IS NULL OR revoked_by_type IN ('user', 'serviceAccount', 'system')
  ),
  revoked_by_id TEXT CHECK (revoked_by_id IS NULL OR length(trim(revoked_by_id)) > 0),
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

CREATE INDEX idx_share_grants_target
  ON share_grants (
    project_id,
    definition_id,
    target_object_type_id,
    target_primary_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX idx_share_grants_project_created
  ON share_grants (project_id, created_at DESC, id DESC);

CREATE INDEX idx_share_grants_expiry
  ON share_grants (project_id, expires_at)
  WHERE revoked_at IS NULL;
