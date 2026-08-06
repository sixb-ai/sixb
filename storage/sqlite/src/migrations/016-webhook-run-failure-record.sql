ALTER TABLE webhook_runs RENAME COLUMN error TO legacy_error;
ALTER TABLE webhook_runs ADD COLUMN error TEXT CHECK (error IS NULL OR json_valid(error));

UPDATE webhook_runs
SET error = json_object(
  'code', 'internal.unexpected',
  'message', 'An unexpected internal error occurred.',
  'retryable', json('false'),
  'at', COALESCE(finished_at, started_at),
  'details', json_object(
    'connectorId', connector_id,
    'webhookId', webhook_id,
    'runId', id,
    'migratedFromLegacyError', json('true')
  )
)
WHERE legacy_error IS NOT NULL;

ALTER TABLE webhook_runs DROP COLUMN legacy_error;
