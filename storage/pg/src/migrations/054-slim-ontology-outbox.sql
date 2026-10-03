-- An outbox event stores what changed and nothing it can be rebuilt from: delivery rebuilds the
-- event from its commit and the execution that commit ran under. The commit also stops copying
-- `requested_by` and `executor` from that execution (047): the execution is canonical, immutable,
-- and already referenced by the commit.

-- Every stored event must rebuild exactly as it was stored: consumers would otherwise receive a
-- different event than the one committed. Fail rather than convert one that would not. Who asked
-- and what wrote are derived from the execution exactly as 047 derived the commit's copies.
DO $$
DECLARE
  mismatched BIGINT;
BEGIN
  SELECT COUNT(*) INTO mismatched
  FROM ontology_outbox AS outbox
  LEFT JOIN ontology_commits AS commits
    ON commits.project_id = outbox.project_id AND commits.id = outbox.commit_id
  LEFT JOIN executions
    ON executions.project_id = commits.project_id AND executions.id = commits.execution_id
  CROSS JOIN LATERAL (
    SELECT outbox.envelope->>'type' AS type, outbox.envelope->'payload' AS payload
  ) AS event
  CROSS JOIN LATERAL (
    SELECT
      CASE
        WHEN executions.requested_by_user_id IS NOT NULL
          THEN jsonb_build_object('type', 'user', 'id', executions.requested_by_user_id)
        WHEN executions.requested_by_service_account_id IS NOT NULL
          THEN jsonb_build_object(
            'type', 'serviceAccount', 'id', executions.requested_by_service_account_id
          )
      END AS requested_by,
      CASE executions.executor_kind
        WHEN 'request'
          THEN jsonb_build_object('type', 'request', 'requestId', executions.executor_id)
        WHEN 'agent' THEN jsonb_build_object('type', 'agent', 'runId', executions.executor_id)
        WHEN 'kernel' THEN jsonb_build_object(
          'type', 'kernel',
          'operation',
          CASE executions.authority_kernel_operation
            WHEN 'ontology.recover'
              THEN jsonb_build_object('type', 'ontology.recover', 'recoveryId', executions.executor_id)
            ELSE jsonb_build_object(
              'type', 'ontology.indexVectors', 'indexingId', executions.executor_id
            )
          END
        )
        ELSE jsonb_build_object(
          'type', 'primitive',
          'kind', executions.executor_kind,
          'id', executions.authority_primitive_id,
          'runId', executions.executor_id
        )
      END AS executor
  ) AS attribution
  WHERE executions.id IS NULL
    OR outbox.envelope->>'id' IS DISTINCT FROM outbox.id
    OR (outbox.envelope->>'commitOrdinal')::bigint IS DISTINCT FROM outbox.commit_ordinal
    OR outbox.envelope->>'commitId' IS DISTINCT FROM commits.id
    OR outbox.envelope->>'projectId' IS DISTINCT FROM commits.project_id
    OR outbox.envelope->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR (outbox.envelope->>'occurredAt')::timestamptz IS DISTINCT FROM commits.committed_at
    OR outbox.envelope->'origin' IS DISTINCT FROM commits.origin
    OR outbox.envelope->>'correlationId' IS DISTINCT FROM executions.correlation_id
    OR outbox.envelope->'requestedBy' IS DISTINCT FROM attribution.requested_by
    OR outbox.envelope->'executor' IS DISTINCT FROM attribution.executor
    OR outbox.envelope->>'topic' IS DISTINCT FROM CASE split_part(event.type, '.', 1)
      WHEN 'object' THEN 'objects'
      WHEN 'link' THEN 'links'
      WHEN 'telemetry' THEN 'telemetry'
    END
    OR outbox.envelope->>'partitionKey' IS DISTINCT FROM CASE split_part(event.type, '.', 1)
      WHEN 'object' THEN concat_ws(':', event.payload->>'objectTypeId', event.payload->>'primaryId')
      WHEN 'link' THEN concat_ws(
        ':', event.payload->>'sourceTypeId', event.payload->>'sourceId', event.payload->>'linkId'
      )
      WHEN 'telemetry' THEN concat_ws(
        ':', event.payload->>'objectTypeId', event.payload->>'objectId', event.payload->>'propertyId'
      )
    END
    OR (
      event.type IN ('object.created', 'link.created')
      AND event.payload->'propertyChanges' IS DISTINCT FROM COALESCE(
        (
          SELECT jsonb_object_agg(
            property.key, jsonb_build_object('operation', 'created', 'after', property.value)
          )
          FROM jsonb_each(COALESCE(event.payload->'properties', '{}'::jsonb)) AS property
        ),
        '{}'::jsonb
      )
    );
  IF mismatched > 0 THEN
    RAISE EXCEPTION '[SixbPg] % outbox events would not rebuild from their commit.', mismatched;
  END IF;
END $$;

ALTER TABLE ontology_outbox ADD COLUMN event JSONB;
UPDATE ontology_outbox SET event = jsonb_build_object(
  'type', envelope->'type',
  'payload', CASE
    WHEN envelope->>'type' IN ('object.created', 'link.created')
      THEN (envelope->'payload') - 'propertyChanges'
    ELSE envelope->'payload'
  END
);
ALTER TABLE ontology_outbox ALTER COLUMN event SET NOT NULL, DROP COLUMN envelope;

ALTER TABLE ontology_commits DROP COLUMN requested_by, DROP COLUMN executor;
