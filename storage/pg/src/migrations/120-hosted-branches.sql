-- The branches that run next to production: one row each, written whole by whoever holds it and
-- compared by revision, so a stale write is refused rather than lost.
CREATE TABLE hosted_branches (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  PRIMARY KEY (project_id, name)
);
