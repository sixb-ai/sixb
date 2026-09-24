-- Commits and their events name who requested the write and what ran it, replacing the
-- authority-only `actor`. Both are copied from the commit's execution, which stays canonical and
-- is immutable, so the backfill is exact. SQLite cannot add a NOT NULL column without a default;
-- every insert supplies `executor`, and the UPDATE below replaces the placeholder on every row.
ALTER TABLE ontology_commits ADD COLUMN requested_by TEXT
  CHECK (requested_by IS NULL OR json_valid(requested_by));
ALTER TABLE ontology_commits ADD COLUMN executor TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(executor));

UPDATE ontology_commits SET
  requested_by = (
    SELECT CASE
      WHEN e.requested_by_user_id IS NOT NULL
        THEN json_object('id', e.requested_by_user_id, 'type', 'user')
      WHEN e.requested_by_service_account_id IS NOT NULL
        THEN json_object('id', e.requested_by_service_account_id, 'type', 'serviceAccount')
    END
    FROM executions e
    WHERE e.project_id = ontology_commits.project_id AND e.id = ontology_commits.execution_id
  ),
  executor = (
    SELECT CASE e.executor_kind
      WHEN 'request' THEN json_object('requestId', e.executor_id, 'type', 'request')
      WHEN 'agent' THEN json_object('runId', e.executor_id, 'type', 'agent')
      WHEN 'kernel' THEN json_object(
        'operation',
        CASE e.authority_kernel_operation
          WHEN 'ontology.recover'
            THEN json_object('recoveryId', e.executor_id, 'type', 'ontology.recover')
          ELSE json_object('indexingId', e.executor_id, 'type', 'ontology.indexVectors')
        END,
        'type', 'kernel'
      )
      ELSE json_object(
        'id', e.authority_primitive_id,
        'kind', e.executor_kind,
        'runId', e.executor_id,
        'type', 'primitive'
      )
    END
    FROM executions e
    WHERE e.project_id = ontology_commits.project_id AND e.id = ontology_commits.execution_id
  );

-- Events not yet published would otherwise reach consumers in the retired shape.
UPDATE ontology_outbox SET envelope = (
  SELECT json_remove(
    CASE
      WHEN c.requested_by IS NULL
        THEN json_set(ontology_outbox.envelope, '$.executor', json(c.executor))
      ELSE json_set(
        ontology_outbox.envelope,
        '$.executor', json(c.executor),
        '$.requestedBy', json(c.requested_by)
      )
    END,
    '$.actor'
  )
  FROM ontology_commits c
  WHERE c.project_id = ontology_outbox.project_id AND c.id = ontology_outbox.commit_id
)
WHERE EXISTS (
  SELECT 1 FROM ontology_commits c
  WHERE c.project_id = ontology_outbox.project_id AND c.id = ontology_outbox.commit_id
);

ALTER TABLE ontology_commits DROP COLUMN actor;
