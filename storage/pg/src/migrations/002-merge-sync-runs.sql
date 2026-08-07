ALTER TABLE sync_runs
  DROP CONSTRAINT sync_runs_mode_check,
  ADD CONSTRAINT sync_runs_mode_check CHECK (mode IN ('snapshot', 'append', 'merge'));
