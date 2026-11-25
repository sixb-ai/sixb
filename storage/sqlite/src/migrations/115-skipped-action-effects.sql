-- A branch skips an Action's effects and records them as skipped. SQLite cannot alter a CHECK
-- constraint, so the table is rebuilt as `060-terminal-action-runs` left it, with 'skipped' added.
CREATE TABLE action_runs_v3 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('none', 'object')),
  object_type_id TEXT,
  primary_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  phase TEXT NOT NULL CHECK (phase IN ('validation', 'writeback', 'edits', 'commit', 'effects')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  params TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  writeback_status TEXT CHECK (writeback_status IS NULL OR writeback_status IN ('succeeded', 'failed')),
  writeback_completed_at TEXT,
  writeback_result TEXT,
  writeback_error TEXT CHECK (writeback_error IS NULL OR json_valid(writeback_error)),
  effects_status TEXT CHECK (
    effects_status IS NULL OR effects_status IN ('succeeded', 'failed', 'skipped')
  ),
  effects_completed_at TEXT,
  effects_error TEXT CHECK (effects_error IS NULL OR json_valid(effects_error)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  CHECK (
    (subject_kind = 'none' AND object_type_id IS NULL AND primary_id IS NULL)
    OR (subject_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL)
  ),
  CHECK ((status = 'failed') = (error IS NOT NULL)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id)
);

INSERT INTO action_runs_v3 (
  project_id, id, execution_id, action_id, subject_kind, object_type_id, primary_id, status,
  phase, started_at, finished_at, params, idempotency_key, writeback_status,
  writeback_completed_at, writeback_result, writeback_error, effects_status,
  effects_completed_at, effects_error, error
)
SELECT
  project_id, id, execution_id, action_id, subject_kind, object_type_id, primary_id, status,
  phase, started_at, finished_at, params, idempotency_key, writeback_status,
  writeback_completed_at, writeback_result, writeback_error, effects_status,
  effects_completed_at, effects_error, error
FROM action_runs;

DROP TABLE action_runs;
ALTER TABLE action_runs_v3 RENAME TO action_runs;

CREATE INDEX idx_action_runs_project_started
  ON action_runs(project_id, started_at DESC);
CREATE INDEX idx_action_runs_project_action_started
  ON action_runs(project_id, action_id, started_at DESC);
CREATE INDEX idx_action_runs_project_object_started
  ON action_runs(project_id, object_type_id, primary_id, started_at DESC);
CREATE INDEX idx_action_runs_project_status_started
  ON action_runs(project_id, status, started_at DESC);
