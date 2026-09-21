CREATE TABLE object_vector_indexing (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  request JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  available_at TIMESTAMPTZ NOT NULL,
  dispatch_at TIMESTAMPTZ NOT NULL,
  values_json JSONB,
  error TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, object_type_id, primary_id, profile)
);
CREATE INDEX object_vector_indexing_due ON object_vector_indexing (project_id, dispatch_at, id)
  WHERE status <> 'failed';

ALTER TABLE executions DROP CONSTRAINT executions_authority_kernel_operation_check;
ALTER TABLE executions ADD CONSTRAINT executions_authority_kernel_operation_check
  CHECK (authority_kernel_operation IS NULL OR authority_kernel_operation IN ('ontology.recover', 'ontology.indexVectors'));
ALTER TABLE executions DROP CONSTRAINT executions_source_kind_check;
ALTER TABLE executions ADD CONSTRAINT executions_source_kind_check
  CHECK (source_kind IN ('http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution', 'ontologyCommit'));
