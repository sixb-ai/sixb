-- The legacy record has no failure timestamp. Use its next availability time as the closest
-- durable timestamp and mark that approximation explicitly in details.
ALTER TABLE ontology_outbox RENAME COLUMN last_error TO last_failure;

ALTER TABLE ontology_outbox
  ALTER COLUMN last_failure TYPE JSONB
  USING (
    CASE
      WHEN last_failure IS NULL
        OR last_failure = 'Outbox dispatcher stopped before publication completed.'
      THEN NULL
      ELSE jsonb_build_object(
        'code', 'event.delivery_failed',
        'message', 'Event delivery failed.',
        'retryable', true,
        'at', to_char(
          available_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'details', jsonb_build_object(
          'attempts', attempts,
          'eventIds', jsonb_build_array(id),
          'eventTypes', jsonb_build_array(envelope->>'type'),
          'migratedFromLegacyLastError', true,
          'timestampSource', 'availableAt'
        )
      )
    END
  );
