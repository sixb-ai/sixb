CREATE TABLE share_grants (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  share_type_id TEXT NOT NULL CHECK (length(trim(share_type_id)) > 0),
  object_type_id TEXT NOT NULL CHECK (length(trim(object_type_id)) > 0),
  primary_id TEXT NOT NULL CHECK (length(trim(primary_id)) > 0),
  issued_by_type TEXT NOT NULL CHECK (issued_by_type IN ('user', 'serviceAccount')),
  issued_by_id TEXT NOT NULL CHECK (length(trim(issued_by_id)) > 0),
  grants TEXT NOT NULL CHECK (
    json_valid(grants) AND json_type(grants) = 'array' AND json_array_length(grants) > 0
  ),
  token_digest TEXT NOT NULL CHECK (length(trim(token_digest)) > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_type TEXT CHECK (
    revoked_by_type IS NULL OR revoked_by_type IN ('user', 'serviceAccount')
  ),
  revoked_by_id TEXT CHECK (
    revoked_by_id IS NULL OR length(trim(revoked_by_id)) > 0
  ),
  issued_evidence_id TEXT NOT NULL CHECK (length(trim(issued_evidence_id)) > 0),
  revoked_evidence_id TEXT CHECK (
    revoked_evidence_id IS NULL OR length(trim(revoked_evidence_id)) > 0
  ),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, token_digest),
  UNIQUE (project_id, issued_evidence_id),
  UNIQUE (project_id, revoked_evidence_id),
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by_type IS NULL AND revoked_by_id IS NULL AND revoked_evidence_id IS NULL)
    OR
    (revoked_at IS NOT NULL AND revoked_by_type IS NOT NULL AND revoked_by_id IS NOT NULL AND revoked_evidence_id IS NOT NULL)
  )
);

CREATE INDEX idx_share_grants_target
  ON share_grants (project_id, share_type_id, object_type_id, primary_id, created_at DESC);
CREATE INDEX idx_share_grants_expiry
  ON share_grants (project_id, expires_at)
  WHERE revoked_at IS NULL;
