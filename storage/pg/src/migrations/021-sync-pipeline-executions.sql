ALTER TABLE sync_runs
  DROP CONSTRAINT sync_runs_status_check,
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD COLUMN queued_at TIMESTAMPTZ NOT NULL,
  ALTER COLUMN started_at DROP NOT NULL,
  ADD CONSTRAINT sync_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT fk_sync_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_sync_runs_execution UNIQUE (project_id, execution_id);

DROP INDEX idx_sync_runs_project_started;
DROP INDEX idx_sync_runs_project_dataset_started;
DROP INDEX idx_sync_runs_project_sync_started;
DROP INDEX idx_sync_runs_project_status_started;

CREATE INDEX idx_sync_runs_project_started
  ON sync_runs (project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_dataset_started
  ON sync_runs (project_id, dataset_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_sync_started
  ON sync_runs (project_id, sync_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_sync_runs_project_status_started
  ON sync_runs (project_id, status, COALESCE(started_at, queued_at) DESC);

ALTER TABLE pipeline_runs
  DROP CONSTRAINT pipeline_runs_status_check,
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD COLUMN queued_at TIMESTAMPTZ NOT NULL,
  ALTER COLUMN started_at DROP NOT NULL,
  ADD CONSTRAINT pipeline_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  ADD CONSTRAINT fk_pipeline_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_pipeline_runs_execution UNIQUE (project_id, execution_id);

DROP INDEX idx_pipeline_runs_project_started;
DROP INDEX idx_pipeline_runs_project_pipeline_started;
DROP INDEX idx_pipeline_runs_project_status_started;

CREATE INDEX idx_pipeline_runs_project_started
  ON pipeline_runs (project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_pipeline_runs_project_pipeline_started
  ON pipeline_runs (project_id, pipeline_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_pipeline_runs_project_status_started
  ON pipeline_runs (project_id, status, COALESCE(started_at, queued_at) DESC);
