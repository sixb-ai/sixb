ALTER TABLE action_runs
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD CONSTRAINT fk_action_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_action_runs_execution UNIQUE (project_id, execution_id);
