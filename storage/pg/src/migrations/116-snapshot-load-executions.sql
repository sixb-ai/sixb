-- Loading a snapshot into a branch runs as the kernel operation `ontology.loadSnapshot`: its base
-- commit is the operation's. The check is `NOT VALID`: a widened list cannot break a row that
-- exists, and validating would scan `executions` under this lock.
ALTER TABLE executions DROP CONSTRAINT executions_authority_kernel_operation_check;
ALTER TABLE executions ADD CONSTRAINT executions_authority_kernel_operation_check
  CHECK (
    authority_kernel_operation IS NULL
      OR authority_kernel_operation IN (
        'ontology.recover', 'ontology.indexVectors', 'artifacts.transcribeMedia',
        'ontology.loadSnapshot'
      )
  ) NOT VALID;
