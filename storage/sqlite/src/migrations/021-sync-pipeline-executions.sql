-- Existing rows cannot be assigned honest authority retroactively. These NOT NULL additions
-- intentionally fail on non-empty legacy tables instead of inventing execution provenance.
ALTER TABLE sync_runs ADD COLUMN execution_id TEXT NOT NULL;
ALTER TABLE sync_runs ADD COLUMN queued_at TEXT NOT NULL;

DROP INDEX idx_sync_runs_project_started;
DROP INDEX idx_sync_runs_project_dataset_started;
DROP INDEX idx_sync_runs_project_sync_started;
DROP INDEX idx_sync_runs_project_status_started;

CREATE TABLE sync_runs_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append', 'merge')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  rows_read INTEGER CHECK (rows_read IS NULL OR rows_read >= 0),
  output_version_id TEXT,
  expected_latest_version_id TEXT,
  commit_message TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  checkpoint TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT
);

INSERT INTO sync_runs_v2 (
  project_id, id, execution_id, sync_id, dataset_id, mode, status, queued_at, started_at,
  finished_at, rows_read, output_version_id, expected_latest_version_id, commit_message,
  error, checkpoint
)
SELECT
  project_id, id, execution_id, sync_id, dataset_id, mode, status, queued_at, started_at,
  finished_at, rows_read, output_version_id, expected_latest_version_id, commit_message,
  error, checkpoint
FROM sync_runs;

DROP TABLE sync_runs;
ALTER TABLE sync_runs_v2 RENAME TO sync_runs;

CREATE INDEX idx_sync_runs_project_started
  ON sync_runs(project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_dataset_started
  ON sync_runs(project_id, dataset_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_sync_started
  ON sync_runs(project_id, sync_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_status_started
  ON sync_runs(project_id, status, COALESCE(started_at, queued_at) DESC);

ALTER TABLE pipeline_runs ADD COLUMN execution_id TEXT NOT NULL;
ALTER TABLE pipeline_runs ADD COLUMN queued_at TEXT NOT NULL;

DROP INDEX idx_pipeline_runs_project_started;
DROP INDEX idx_pipeline_runs_project_pipeline_started;
DROP INDEX idx_pipeline_runs_project_status_started;

CREATE TABLE pipeline_runs_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  output_dataset_id TEXT,
  output_version_id TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT
);

INSERT INTO pipeline_runs_v2 (
  project_id, id, execution_id, pipeline_id, status, queued_at, started_at, finished_at,
  output_dataset_id, output_version_id, error
)
SELECT
  project_id, id, execution_id, pipeline_id, status, queued_at, started_at, finished_at,
  output_dataset_id, output_version_id, error
FROM pipeline_runs;

DROP TABLE pipeline_runs;
ALTER TABLE pipeline_runs_v2 RENAME TO pipeline_runs;

CREATE INDEX idx_pipeline_runs_project_started
  ON pipeline_runs(project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_pipeline_runs_project_pipeline_started
  ON pipeline_runs(project_id, pipeline_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_pipeline_runs_project_status_started
  ON pipeline_runs(project_id, status, COALESCE(started_at, queued_at) DESC);
