-- A cancel is recorded on the run, not only broadcast: a runner that never hears the broker learns
-- of it at its next lease renewal, and the run token stops working at once.
ALTER TABLE agent_runs ADD COLUMN cancel_requested_at TEXT;
