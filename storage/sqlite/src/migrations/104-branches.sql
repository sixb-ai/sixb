-- One row per git branch of the project with a runtime of its own. The revision guards every
-- write: the worker holding a branch's sandbox writes only over what it read.
CREATE TABLE branches (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  record TEXT NOT NULL CHECK (json_type(record) = 'object'),
  PRIMARY KEY (project_id, name)
);
