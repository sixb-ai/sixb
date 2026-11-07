-- A sync or pipeline run now survives its worker: each execution holds the run under a token that
-- fences its writes, and projects its queue lease here so another delivery can tell a live holder
-- from a dead one. A run with neither was started by an older version: nothing backfills it, and the
-- recovery pass settles it once its old worker cannot still be alive.
--
-- Every column is added without touching a row. Constraints are `NOT VALID`: rows that exist cannot
-- break them, and validating would scan the table under this lock.
ALTER TABLE sync_runs
  ADD COLUMN attempt BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN execution_token TEXT,
  ADD COLUMN execution_queue_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN commit_prepared_at TIMESTAMPTZ,
  ADD CONSTRAINT sync_runs_attempt_check CHECK (attempt >= 0) NOT VALID,
  ADD CONSTRAINT sync_runs_execution_lease_check
    CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)) NOT VALID;

ALTER TABLE pipeline_runs
  ADD COLUMN attempt BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN execution_token TEXT,
  ADD COLUMN execution_queue_lease_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT pipeline_runs_attempt_check CHECK (attempt >= 0) NOT VALID,
  ADD CONSTRAINT pipeline_runs_execution_lease_check
    CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)) NOT VALID;
