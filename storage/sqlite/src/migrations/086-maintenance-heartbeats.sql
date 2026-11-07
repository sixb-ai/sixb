-- One row per project, rewritten by the maintenance loop as it runs. Another process reads it to
-- tell a stopped loop from a quiet one.
CREATE TABLE maintenance_heartbeats (
  project_id TEXT PRIMARY KEY CHECK (length(trim(project_id)) > 0),
  beat_at TEXT NOT NULL,
  every_ms INTEGER NOT NULL CHECK (every_ms > 0),
  passes TEXT NOT NULL CHECK (json_type(passes) = 'array')
);
