-- A webhook handler runs in the request, with no queue behind it, so the process running it keeps
-- its own lease. A run with none was started by an older API, and is judged from when it started.
-- A projection run holds a lease as other runs do, so a duplicate delivery leaves a live run alone.
--
-- These add nullable columns, which touches no row.
ALTER TABLE webhook_runs
  ADD COLUMN execution_token TEXT,
  ADD COLUMN execution_lease_expires_at TIMESTAMPTZ;

ALTER TABLE projection_runs ADD COLUMN execution_queue_lease_expires_at TIMESTAMPTZ;
