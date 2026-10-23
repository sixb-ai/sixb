-- Agent memory: each repo, 'user:<userId>' or 'project', is a log of revisions. A save inserts one
-- revision and the file versions it wrote, and never updates a row. A file's current contents are
-- its highest-revision version; NULL contents mean that revision deleted it. Timestamps are
-- ISO-8601 UTC text and compare lexicographically.
CREATE TABLE agent_memory_revisions (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  repo_id TEXT NOT NULL CHECK (length(trim(repo_id)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  message TEXT NOT NULL CHECK (length(trim(message)) > 0),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  source TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repo_id, revision)
);

-- A save also removes versions older than 90 days that are not their path's latest, so a
-- revision's rows here can be fewer than the files it wrote.
CREATE TABLE agent_memory_files (
  project_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL CHECK (length(path) > 0),
  revision INTEGER NOT NULL,
  contents TEXT,
  PRIMARY KEY (project_id, repo_id, path, revision),
  FOREIGN KEY (project_id, repo_id, revision)
    REFERENCES agent_memory_revisions (project_id, repo_id, revision) ON DELETE CASCADE
);

CREATE INDEX idx_agent_memory_files_revision
  ON agent_memory_files (project_id, repo_id, revision);
