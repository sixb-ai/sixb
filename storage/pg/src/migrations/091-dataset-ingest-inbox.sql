-- Changes `sixb.datasets.ingest` stored and no flush has written to the lake yet. A flush tags the
-- deliveries it takes with its id, writes them as one dataset version, then deletes them.
CREATE TABLE dataset_ingest_deliveries (
  id BIGSERIAL,
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  change_count INTEGER NOT NULL CHECK (change_count > 0),
  -- Text, not JSONB: nothing reads inside it, and JSONB refuses strings JSON allows.
  changes TEXT NOT NULL,
  flush_id TEXT,
  -- Led by the dataset, so no plan for one dataset walks the deliveries of another.
  PRIMARY KEY (project_id, dataset_id, id)
);
CREATE INDEX dataset_ingest_deliveries_by_flush
  ON dataset_ingest_deliveries (project_id, dataset_id, flush_id, id);

-- One row per dataset: its open flush request, the lease of the flush that holds it, the batch
-- that flush took, and when a batch last completed. Locking this row orders requests against batches.
CREATE TABLE dataset_ingest_state (
  project_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  request BIGINT NOT NULL DEFAULT 0,
  requested BOOLEAN NOT NULL DEFAULT FALSE,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  flush_id TEXT,
  flush_started_at TIMESTAMPTZ,
  failure_streak INTEGER NOT NULL DEFAULT 0,
  last_flushed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, dataset_id)
);
