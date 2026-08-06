ALTER TABLE webhook_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE webhook_runs ADD COLUMN error JSONB;

UPDATE webhook_runs
SET error = jsonb_build_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', false,
  'at', to_char(COALESCE(finished_at, started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'details', jsonb_build_object(
    'connectorId', connector_id,
    'webhookId', webhook_id,
    'runId', id,
    'migratedFromLegacyError', true
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE webhook_runs DROP COLUMN legacy_error;
