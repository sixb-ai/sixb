ALTER TABLE workflow_runs ADD COLUMN execution_id TEXT NOT NULL;
ALTER TABLE workflow_runs DROP COLUMN source;
ALTER TABLE workflow_runs DROP COLUMN requested_by_principal_type;
ALTER TABLE workflow_runs DROP COLUMN requested_by_principal_id;

CREATE UNIQUE INDEX idx_workflow_runs_project_execution
  ON workflow_runs(project_id, execution_id);
