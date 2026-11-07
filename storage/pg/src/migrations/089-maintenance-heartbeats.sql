-- One row per project and owner, rewritten by that owner's maintenance loop as it runs. Another
-- process reads it to tell a stopped loop from a quiet one.
CREATE TABLE maintenance_heartbeats (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  owner TEXT NOT NULL CHECK (owner IN ('orchestrator', 'embedded')),
  beat_at TIMESTAMPTZ NOT NULL,
  every_ms INTEGER NOT NULL CHECK (every_ms > 0),
  passes JSONB NOT NULL CHECK (jsonb_typeof(passes) = 'array'),
  PRIMARY KEY (project_id, owner)
);
