-- Existing Webhook runs and delivery claims cannot be assigned honest authority retroactively.
-- Fail before changing the schema instead of inventing execution provenance or discarding claims.
SELECT 1 / CASE
  WHEN EXISTS (SELECT 1 FROM webhook_runs) OR EXISTS (SELECT 1 FROM webhook_deliveries)
  THEN 0
  ELSE 1
END;

ALTER TABLE webhook_runs
  DROP CONSTRAINT webhook_runs_status_check,
  ADD COLUMN execution_id TEXT NOT NULL,
  ADD COLUMN request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64),
  ALTER COLUMN request_body_bytes SET NOT NULL,
  DROP COLUMN delivery_claim_result,
  ADD CONSTRAINT webhook_runs_status_check
    CHECK (status IN ('running', 'succeeded', 'failed')),
  ADD CONSTRAINT webhook_runs_lifecycle_check CHECK (
    (status = 'running' AND finished_at IS NULL AND response_status IS NULL AND error IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL)
  ),
  ADD CONSTRAINT fk_webhook_runs_execution
    FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_webhook_runs_execution UNIQUE (project_id, execution_id),
  ADD CONSTRAINT uq_webhook_runs_delivery
    UNIQUE (project_id, connector_id, webhook_id, idempotency_key);

DROP TABLE webhook_deliveries;
