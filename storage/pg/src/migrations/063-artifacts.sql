-- Artifacts: versioned documents, sheets, decks, and files. An artifact's kind never
-- changes. Versions take `next_version`, which only grows, so a number is never reused after its
-- version is deleted.
CREATE TABLE artifacts (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('document', 'sheet', 'slides', 'file')),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  owner_principal_type TEXT NOT NULL
    CHECK (owner_principal_type IN ('user', 'serviceAccount', 'system')),
  owner_principal_id TEXT NOT NULL CHECK (length(owner_principal_id) > 0),
  latest_version INTEGER NOT NULL CHECK (latest_version > 0),
  next_version INTEGER NOT NULL CHECK (next_version > latest_version),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_artifacts_project_updated ON artifacts (project_id, updated_at DESC, id);
CREATE INDEX idx_artifacts_owner_updated
  ON artifacts (project_id, owner_principal_type, owner_principal_id, updated_at DESC, id);

-- `refs`, not `references`: that word is reserved in SQL.
CREATE TABLE artifact_versions (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  entry TEXT NOT NULL CHECK (length(entry) > 0),
  files JSONB NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  outline JSONB NOT NULL CHECK (jsonb_typeof(outline) = 'object'),
  refs JSONB NOT NULL CHECK (jsonb_typeof(refs) = 'array'),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  origin_thread_id TEXT,
  origin_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, artifact_id, version),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  CHECK ((origin_thread_id IS NULL) = (origin_run_id IS NULL))
);

CREATE INDEX idx_artifact_versions_origin_run
  ON artifact_versions (project_id, origin_run_id) WHERE origin_run_id IS NOT NULL;
CREATE INDEX idx_artifact_versions_origin_thread
  ON artifact_versions (project_id, origin_thread_id, artifact_id) WHERE origin_thread_id IS NOT NULL;

-- Short-lived links that a sandboxed frame loads a deck's files through. Only the SHA-256 of each
-- link's token is stored. `targets` is what the frame may show from other artifacts, decided for
-- its reader when the link was issued: a JSON array of { address, artifactId, version }.
CREATE TABLE artifact_frame_grants (
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  targets JSONB NOT NULL CHECK (jsonb_typeof(targets) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, token_hash),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_artifact_frame_grants_expiry ON artifact_frame_grants (project_id, expires_at);
-- Deleting an artifact cascades here, and Postgres does not index a foreign key by itself.
CREATE INDEX idx_artifact_frame_grants_artifact ON artifact_frame_grants (project_id, artifact_id);
