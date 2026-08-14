ALTER TABLE workflow_runs
  ADD COLUMN execution_id TEXT NOT NULL,
  DROP COLUMN source,
  DROP COLUMN requested_by_principal_type,
  DROP COLUMN requested_by_principal_id,
  ADD CONSTRAINT fk_workflow_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_workflow_runs_execution UNIQUE (project_id, execution_id);
