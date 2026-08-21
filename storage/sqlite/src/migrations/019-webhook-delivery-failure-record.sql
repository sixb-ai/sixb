-- SQLite cannot add the JSON constraint while changing the legacy column, so rebuild the table.
-- Legacy deliveries normally have an exact failure timestamp. Fall back to the receipt timestamp
-- only for inconsistent historical rows and record the source so the approximation stays visible.
DROP INDEX idx_webhook_deliveries_project_received;

ALTER TABLE webhook_deliveries RENAME TO webhook_deliveries_before_failure_record;

CREATE TABLE webhook_deliveries (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  received_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  failure TEXT CHECK (failure IS NULL OR json_valid(failure)),
  PRIMARY KEY (project_id, connector_id, webhook_id, idempotency_key)
);

INSERT INTO webhook_deliveries (
  project_id,
  connector_id,
  webhook_id,
  idempotency_key,
  status,
  received_at,
  completed_at,
  failed_at,
  failure
)
SELECT
  project_id,
  connector_id,
  webhook_id,
  idempotency_key,
  status,
  received_at,
  completed_at,
  failed_at,
  CASE
    WHEN error IS NULL THEN NULL
    ELSE json_object(
      'code', 'webhook.delivery_failed',
      'message', 'Webhook delivery failed.',
      'retryable', json('true'),
      'at', COALESCE(failed_at, received_at),
      'details', json_object(
        'connectorId', connector_id,
        'webhookId', webhook_id,
        'idempotencyKey', idempotency_key,
        'migratedFromLegacyError', json('true'),
        'timestampSource', CASE WHEN failed_at IS NULL THEN 'receivedAt' ELSE 'failedAt' END
      )
    )
  END
FROM webhook_deliveries_before_failure_record;

DROP TABLE webhook_deliveries_before_failure_record;

CREATE INDEX idx_webhook_deliveries_project_received
  ON webhook_deliveries(project_id, received_at DESC);
