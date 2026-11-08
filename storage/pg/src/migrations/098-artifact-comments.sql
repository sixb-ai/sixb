-- Comments on an artifact, and replies to them (`parent_id`), each about a board or an element of
-- a canvas, or the artifact itself, at the revision its author saw (`anchor`). They go with the
-- artifact, and a reply with what it replies to; a copy of the artifact keeps none.
-- `seq` orders comments made in the same instant as they were made.
CREATE TABLE artifact_comments (
  seq BIGINT GENERATED ALWAYS AS IDENTITY,
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  parent_id TEXT,
  anchor JSONB NOT NULL CHECK (jsonb_typeof(anchor) = 'object'),
  body TEXT NOT NULL CHECK (length(body) > 0),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolved_by_principal_type TEXT
    CHECK (resolved_by_principal_type IN ('user', 'serviceAccount', 'system')),
  resolved_by_principal_id TEXT CHECK (length(resolved_by_principal_id) > 0),
  PRIMARY KEY (project_id, artifact_id, id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, artifact_id, parent_id)
    REFERENCES artifact_comments (project_id, artifact_id, id) ON DELETE CASCADE,
  CHECK (
    (resolved_at IS NULL) = (resolved_by_principal_type IS NULL)
    AND (resolved_by_principal_type IS NULL) = (resolved_by_principal_id IS NULL)
  )
);

CREATE INDEX idx_artifact_comments_created
  ON artifact_comments (project_id, artifact_id, created_at, seq);
