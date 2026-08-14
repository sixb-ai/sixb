ALTER TABLE action_runs ADD COLUMN execution_id TEXT NOT NULL;

CREATE UNIQUE INDEX idx_action_runs_project_execution
  ON action_runs(project_id, execution_id);
