ALTER TABLE executions
  DROP CONSTRAINT executions_source_kind_check,
  ADD CONSTRAINT executions_source_kind_check CHECK (
    source_kind IN ('http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution')
  );

-- Existing Projection rows cannot be assigned honest authority. Refuse them explicitly before
-- rebuilding anything; this guard is migration-local and leaves no function or trigger behind.
CREATE TEMP TABLE projection_execution_migration_guard (
  must_be_empty BOOLEAN NOT NULL CHECK (must_be_empty = FALSE)
) ON COMMIT DROP;
INSERT INTO projection_execution_migration_guard (must_be_empty)
  SELECT TRUE FROM projection_runs LIMIT 1;
DROP TABLE projection_execution_migration_guard;

DROP TABLE projection_runs;

CREATE TABLE projection_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link', 'telemetry')),
  materialization_protocol TEXT NOT NULL CHECK (
    materialization_protocol IN ('replacement', 'telemetry')
  ),
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  dataset_version_created_at TEXT NOT NULL,
  ontology_revision TEXT NOT NULL,
  projection_revision TEXT NOT NULL,
  ownership_hash TEXT NOT NULL,
  object_type_id TEXT,
  source_object_type_id TEXT,
  target_object_type_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  queued_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  attempt BIGINT NOT NULL CHECK (attempt >= 0),
  execution_token TEXT,
  fixed_batch_size BIGINT CHECK (fixed_batch_size IS NULL OR fixed_batch_size > 0),
  next_batch_ordinal BIGINT CHECK (next_batch_ordinal IS NULL OR next_batch_ordinal >= 0),
  next_row_offset BIGINT CHECK (next_row_offset IS NULL OR next_row_offset >= 0),
  input_exhausted BOOLEAN,
  missing_target_object_type_id TEXT,
  missing_target_object_id TEXT,
  missing_target_batch_ordinal BIGINT CHECK (
    missing_target_batch_ordinal IS NULL OR missing_target_batch_ordinal >= 0
  ),
  missing_target_first_seen_at TIMESTAMPTZ,
  source_rows_read BIGINT NOT NULL DEFAULT 0 CHECK (source_rows_read >= 0),
  source_rows_skipped BIGINT NOT NULL DEFAULT 0 CHECK (source_rows_skipped >= 0),
  error JSONB,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  CHECK (source_rows_skipped <= source_rows_read),
  CHECK ((status = 'running') = (execution_token IS NOT NULL)),
  CHECK (
    (status = 'queued' AND attempt = 0 AND started_at IS NULL AND finished_at IS NULL
      AND error IS NULL)
    OR (status = 'running' AND attempt >= 1 AND started_at IS NOT NULL AND finished_at IS NULL
      AND error IS NULL)
    OR (
      status IN ('succeeded', 'failed', 'cancelled')
      AND finished_at IS NOT NULL
      AND (
        (error->>'code' = 'queue.enqueue_failed'
          AND status = 'failed' AND attempt = 0 AND started_at IS NULL)
        OR (COALESCE(error->>'code', '') != 'queue.enqueue_failed'
          AND attempt >= 1 AND started_at IS NOT NULL)
      )
    )
  ),
  CHECK (status != 'succeeded' OR error IS NULL),
  CHECK ((projection_kind = 'telemetry') = (materialization_protocol = 'telemetry')),
  CHECK (
    (projection_kind = 'link' AND object_type_id IS NULL
      AND source_object_type_id IS NOT NULL AND target_object_type_id IS NOT NULL)
    OR (projection_kind IN ('object', 'telemetry') AND object_type_id IS NOT NULL
      AND source_object_type_id IS NULL AND target_object_type_id IS NULL)
  ),
  CHECK (
    (materialization_protocol = 'replacement' AND fixed_batch_size IS NULL
      AND next_batch_ordinal IS NULL AND next_row_offset IS NULL AND input_exhausted IS NULL)
    OR (materialization_protocol = 'telemetry' AND fixed_batch_size IS NOT NULL
      AND next_batch_ordinal IS NOT NULL AND next_row_offset IS NOT NULL
      AND input_exhausted IS NOT NULL)
  ),
  CHECK (
    (missing_target_object_type_id IS NULL AND missing_target_object_id IS NULL
      AND missing_target_batch_ordinal IS NULL AND missing_target_first_seen_at IS NULL)
    OR (projection_kind = 'telemetry' AND missing_target_object_type_id = object_type_id
      AND missing_target_object_id IS NOT NULL
      AND missing_target_batch_ordinal = next_batch_ordinal
      AND missing_target_first_seen_at IS NOT NULL)
  ),
  CHECK (projection_kind != 'telemetry' OR status != 'succeeded' OR input_exhausted = TRUE)
);

CREATE INDEX idx_projection_runs_project_started
  ON projection_runs (project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_projection_started
  ON projection_runs (project_id, projection_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_dataset_started
  ON projection_runs (project_id, dataset_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_version_started
  ON projection_runs (project_id, dataset_version_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_status_started
  ON projection_runs (project_id, status, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_object_type_started
  ON projection_runs (project_id, object_type_id, COALESCE(started_at, queued_at) DESC);
