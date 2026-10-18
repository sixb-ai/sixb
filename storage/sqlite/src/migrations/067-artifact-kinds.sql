-- Artifacts take two more kinds: pages, and the canvases that lay pages out. SQLite cannot alter a
-- CHECK constraint, so the table is rebuilt; its versions and frame grants reference it by name.
CREATE TABLE artifacts_v2 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('document', 'sheet', 'slides', 'page', 'canvas', 'file')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  owner_principal_type TEXT NOT NULL
    CHECK (owner_principal_type IN ('user', 'serviceAccount', 'system')),
  owner_principal_id TEXT NOT NULL CHECK (length(owner_principal_id) > 0),
  latest_version INTEGER NOT NULL CHECK (latest_version > 0),
  next_version INTEGER NOT NULL CHECK (next_version > latest_version),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

INSERT INTO artifacts_v2 (
  project_id, id, kind, title, owner_principal_type, owner_principal_id, latest_version,
  next_version, created_at, updated_at
)
SELECT
  project_id, id, kind, title, owner_principal_type, owner_principal_id, latest_version,
  next_version, created_at, updated_at
FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_v2 RENAME TO artifacts;

CREATE INDEX idx_artifacts_project_updated ON artifacts (project_id, updated_at DESC, id);
CREATE INDEX idx_artifacts_owner_updated
  ON artifacts (project_id, owner_principal_type, owner_principal_id, updated_at DESC, id);
