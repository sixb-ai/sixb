-- One row per project, rewritten by each automatic lake retention run. The API reads it to tell a
-- request nobody consumes from one a worker ran.
CREATE TABLE lake_retention_runs (
  project_id TEXT PRIMARY KEY CHECK (length(trim(project_id)) > 0),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failed INTEGER NOT NULL CHECK (failed IN (0, 1))
);
