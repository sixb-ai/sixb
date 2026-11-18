-- A sync of an OAuth connector runs once per connection. The column stays NULL for a sync of a
-- static connector, and for runs from before this migration.
ALTER TABLE sync_runs ADD COLUMN connection_id TEXT;

CREATE INDEX idx_sync_runs_project_sync_connection_started
  ON sync_runs(project_id, sync_id, connection_id, COALESCE(started_at, queued_at) DESC);
