-- A sync or pipeline run now survives its worker: each execution holds the run under a token that
-- fences its writes, and projects its queue lease here so another delivery can tell a live holder
-- from a dead one. A run with neither was started by an older version: nothing backfills it, and the
-- recovery pass settles it once its old worker cannot still be alive.
ALTER TABLE sync_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN execution_token TEXT;
ALTER TABLE sync_runs ADD COLUMN execution_queue_lease_expires_at TEXT;
ALTER TABLE sync_runs ADD COLUMN commit_prepared_at TEXT;

ALTER TABLE pipeline_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN execution_token TEXT;
ALTER TABLE pipeline_runs ADD COLUMN execution_queue_lease_expires_at TEXT;
