-- Applying ontology migrations runs as the kernel operation `ontology.migrate`: every batch commit
-- is the operation's. The check is `NOT VALID`: a widened list cannot break a row that exists, and
-- validating would scan `executions` under this lock.
ALTER TABLE executions DROP CONSTRAINT executions_authority_kernel_operation_check;
ALTER TABLE executions ADD CONSTRAINT executions_authority_kernel_operation_check
  CHECK (
    authority_kernel_operation IS NULL
      OR authority_kernel_operation IN (
        'ontology.recover', 'ontology.indexVectors', 'artifacts.transcribeMedia',
        'ontology.loadSnapshot', 'ontology.migrate'
      )
  ) NOT VALID;

-- A type's shape is `migrating` from a run's point of no return until it finishes.
ALTER TABLE ontology_type_shapes
  ADD COLUMN state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current', 'migrating'));
