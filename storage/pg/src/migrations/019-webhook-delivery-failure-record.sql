-- Legacy deliveries normally have an exact failure timestamp. Fall back to the receipt timestamp
-- only for inconsistent historical rows and record the source so the approximation stays visible.
ALTER TABLE webhook_deliveries RENAME COLUMN error TO failure;

ALTER TABLE webhook_deliveries
  ALTER COLUMN failure TYPE JSONB
  USING (
    CASE
      WHEN failure IS NULL THEN NULL
      ELSE jsonb_build_object(
        'code', 'webhook.delivery_failed',
        'message', 'Webhook delivery failed.',
        'retryable', true,
        'at', to_char(
          COALESCE(failed_at, received_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'details', jsonb_build_object(
          'connectorId', connector_id,
          'webhookId', webhook_id,
          'idempotencyKey', idempotency_key,
          'migratedFromLegacyError', true,
          'timestampSource', CASE WHEN failed_at IS NULL THEN 'receivedAt' ELSE 'failedAt' END
        )
      )
    END
  );
