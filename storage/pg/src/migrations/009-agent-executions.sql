ALTER TABLE agent_runs
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD CONSTRAINT fk_agent_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_agent_runs_execution UNIQUE (project_id, execution_id),
  DROP COLUMN requested_by_principal_type,
  DROP COLUMN requested_by_principal_id,
  DROP COLUMN execution_principal_type,
  DROP COLUMN execution_principal_id;

ALTER TABLE workflow_agent_node_runs
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD CONSTRAINT fk_workflow_agent_node_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_workflow_agent_node_runs_execution UNIQUE (project_id, execution_id),
  DROP COLUMN execution_principal_type,
  DROP COLUMN execution_principal_id;
