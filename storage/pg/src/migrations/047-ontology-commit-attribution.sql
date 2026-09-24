-- Commits and their events name who requested the write and what ran it, replacing the
-- authority-only `actor`. Both are copied from the commit's execution, which stays canonical and
-- is immutable, so the backfill is exact.
ALTER TABLE ontology_commits
  ADD COLUMN requested_by JSONB,
  ADD COLUMN executor JSONB;

UPDATE ontology_commits c SET
  requested_by = CASE
    WHEN e.requested_by_user_id IS NOT NULL
      THEN jsonb_build_object('type', 'user', 'id', e.requested_by_user_id)
    WHEN e.requested_by_service_account_id IS NOT NULL
      THEN jsonb_build_object('type', 'serviceAccount', 'id', e.requested_by_service_account_id)
  END,
  executor = CASE e.executor_kind
    WHEN 'request' THEN jsonb_build_object('type', 'request', 'requestId', e.executor_id)
    WHEN 'agent' THEN jsonb_build_object('type', 'agent', 'runId', e.executor_id)
    WHEN 'kernel' THEN jsonb_build_object(
      'type', 'kernel',
      'operation',
      CASE e.authority_kernel_operation
        WHEN 'ontology.recover'
          THEN jsonb_build_object('type', 'ontology.recover', 'recoveryId', e.executor_id)
        ELSE jsonb_build_object('type', 'ontology.indexVectors', 'indexingId', e.executor_id)
      END
    )
    ELSE jsonb_build_object(
      'type', 'primitive',
      'kind', e.executor_kind,
      'id', e.authority_primitive_id,
      'runId', e.executor_id
    )
  END
FROM executions e
WHERE e.project_id = c.project_id AND e.id = c.execution_id;

ALTER TABLE ontology_commits ALTER COLUMN executor SET NOT NULL;

-- Events not yet published would otherwise reach consumers in the retired shape.
UPDATE ontology_outbox o SET envelope =
  (o.envelope - 'actor')
  || jsonb_build_object('executor', c.executor)
  || CASE
    WHEN c.requested_by IS NULL THEN '{}'::jsonb
    ELSE jsonb_build_object('requestedBy', c.requested_by)
  END
FROM ontology_commits c
WHERE c.project_id = o.project_id AND c.id = o.commit_id;

ALTER TABLE ontology_commits DROP COLUMN actor;
