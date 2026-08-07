DROP INDEX idx_sync_runs_project_started;
DROP INDEX idx_sync_runs_project_dataset_started;
DROP INDEX idx_sync_runs_project_sync_started;
DROP INDEX idx_sync_runs_project_status_started;

ALTER TABLE sync_runs RENAME TO sync_runs_before_merge_mode;

CREATE TABLE sync_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append', 'merge')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_read INTEGER CHECK (rows_read IS NULL OR rows_read >= 0),
  output_version_id TEXT,
  expected_latest_version_id TEXT,
  commit_message TEXT,
  error_name TEXT,
  error_message TEXT,
  checkpoint TEXT,
  PRIMARY KEY (project_id, id)
);

INSERT INTO sync_runs (
  project_id,
  id,
  sync_id,
  dataset_id,
  mode,
  status,
  started_at,
  finished_at,
  rows_read,
  output_version_id,
  expected_latest_version_id,
  commit_message,
  error_name,
  error_message,
  checkpoint
)
SELECT
  project_id,
  id,
  sync_id,
  dataset_id,
  mode,
  status,
  started_at,
  finished_at,
  rows_read,
  output_version_id,
  expected_latest_version_id,
  commit_message,
  error_name,
  error_message,
  checkpoint
FROM sync_runs_before_merge_mode;

DROP TABLE sync_runs_before_merge_mode;

CREATE INDEX idx_sync_runs_project_started
  ON sync_runs(project_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_dataset_started
  ON sync_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_sync_started
  ON sync_runs(project_id, sync_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_status_started
  ON sync_runs(project_id, status, started_at DESC);
