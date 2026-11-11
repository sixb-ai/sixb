-- A guest's comment keeps the shared link they came through, by its grant: whoever opens that link,
-- in any session, reads the threads its guests started, and no other. Comments written before take
-- it from their session, which keeps its grant. SQLite cannot add a CHECK constraint, so the table
-- is rebuilt; each comment keeps its rowid, which orders those made in the same instant.
CREATE TABLE artifact_comments_v2 (
  project_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) > 0),
  parent_id TEXT,
  anchor TEXT NOT NULL CHECK (json_type(anchor) = 'object'),
  body TEXT NOT NULL CHECK (length(body) > 0),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system', 'guest')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  author_name TEXT,
  author_grant_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_principal_type TEXT
    CHECK (resolved_by_principal_type IN ('user', 'serviceAccount', 'system')),
  resolved_by_principal_id TEXT CHECK (length(resolved_by_principal_id) > 0),
  -- The Agent's run that wrote it for its author, and that run's conversation.
  origin_thread_id TEXT,
  origin_run_id TEXT,
  PRIMARY KEY (project_id, artifact_id, id),
  FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, artifact_id, parent_id)
    REFERENCES artifact_comments (project_id, artifact_id, id) ON DELETE CASCADE,
  CHECK (
    (resolved_at IS NULL) = (resolved_by_principal_type IS NULL)
    AND (resolved_by_principal_type IS NULL) = (resolved_by_principal_id IS NULL)
  ),
  CHECK ((origin_thread_id IS NULL) = (origin_run_id IS NULL)),
  CHECK (
    (author_principal_type = 'guest') = (author_name IS NOT NULL)
    AND (author_name IS NULL OR length(author_name) > 0)
  ),
  CHECK (
    (author_principal_type = 'guest') = (author_grant_id IS NOT NULL)
    AND (author_grant_id IS NULL OR length(author_grant_id) > 0)
  )
);

INSERT INTO artifact_comments_v2 (
  rowid, project_id, artifact_id, id, parent_id, anchor, body, author_principal_type,
  author_principal_id, author_name, author_grant_id, created_at, resolved_at,
  resolved_by_principal_type, resolved_by_principal_id, origin_thread_id, origin_run_id
)
SELECT
  comment.rowid, comment.project_id, comment.artifact_id, comment.id, comment.parent_id,
  comment.anchor, comment.body, comment.author_principal_type, comment.author_principal_id,
  comment.author_name, session.grant_id, comment.created_at, comment.resolved_at,
  comment.resolved_by_principal_type, comment.resolved_by_principal_id, comment.origin_thread_id,
  comment.origin_run_id
FROM artifact_comments AS comment
LEFT JOIN share_sessions AS session
  ON comment.author_principal_type = 'guest'
  AND session.project_id = comment.project_id
  AND session.id = comment.author_principal_id;

DROP TABLE artifact_comments;
ALTER TABLE artifact_comments_v2 RENAME TO artifact_comments;

CREATE INDEX idx_artifact_comments_created
  ON artifact_comments (project_id, artifact_id, created_at);
