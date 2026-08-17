DROP INDEX idx_webhook_runs_project_started;
DROP INDEX idx_webhook_runs_project_connector_started;
DROP INDEX idx_webhook_runs_project_webhook_started;
DROP INDEX idx_webhook_runs_project_status_started;
DROP INDEX idx_webhook_runs_project_idempotency;

CREATE TABLE webhook_runs_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  request_body_bytes INTEGER NOT NULL CHECK (request_body_bytes >= 0),
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64),
  response_status INTEGER CHECK (
    response_status IS NULL OR (response_status >= 100 AND response_status <= 599)
  ),
  idempotency_key TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  UNIQUE (project_id, connector_id, webhook_id, idempotency_key),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND response_status IS NULL AND error IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL)
  )
);

DROP TABLE webhook_runs;
ALTER TABLE webhook_runs_v2 RENAME TO webhook_runs;
DROP TABLE webhook_deliveries;

CREATE INDEX idx_webhook_runs_project_started
  ON webhook_runs(project_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_connector_started
  ON webhook_runs(project_id, connector_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_webhook_started
  ON webhook_runs(project_id, connector_id, webhook_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_status_started
  ON webhook_runs(project_id, status, started_at DESC);
CREATE INDEX idx_webhook_runs_project_idempotency
  ON webhook_runs(project_id, idempotency_key);
