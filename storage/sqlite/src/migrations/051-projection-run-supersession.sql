-- Projection runs gain the terminal status `superseded`, and a running run may carry the failure
-- of its last attempt in `error` while the queue retries it. SQLite cannot alter a CHECK
-- constraint, so the table is rebuilt.
CREATE TABLE projection_runs_v2 (
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
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'superseded')
  ),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  execution_token TEXT,
  fixed_batch_size INTEGER CHECK (fixed_batch_size > 0),
  next_batch_ordinal INTEGER CHECK (next_batch_ordinal >= 0),
  next_row_offset INTEGER CHECK (next_row_offset >= 0),
  input_exhausted INTEGER CHECK (input_exhausted IN (0, 1)),
  missing_target_object_type_id TEXT,
  missing_target_object_id TEXT,
  missing_target_batch_ordinal INTEGER CHECK (
    missing_target_batch_ordinal IS NULL OR missing_target_batch_ordinal >= 0
  ),
  missing_target_first_seen_at TEXT,
  source_rows_read INTEGER NOT NULL DEFAULT 0 CHECK (source_rows_read >= 0),
  source_rows_skipped INTEGER NOT NULL DEFAULT 0 CHECK (source_rows_skipped >= 0),
  source_changes_read INTEGER CHECK (source_changes_read IS NULL OR source_changes_read >= 0),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id) REFERENCES executions (project_id, id) ON DELETE RESTRICT,
  CHECK (source_rows_skipped <= source_rows_read),
  CHECK ((status = 'running') = (execution_token IS NOT NULL)),
  CHECK (
    (status = 'queued' AND attempt = 0 AND started_at IS NULL AND finished_at IS NULL
      AND error IS NULL)
    OR (status = 'running' AND attempt >= 1 AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (
      status IN ('succeeded', 'failed', 'cancelled', 'superseded')
      AND finished_at IS NOT NULL
      AND (
        (json_extract(error, '$.code') = 'queue.enqueue_failed'
          AND status = 'failed' AND attempt = 0 AND started_at IS NULL)
        OR (COALESCE(json_extract(error, '$.code'), '') != 'queue.enqueue_failed'
          AND attempt >= 1 AND started_at IS NOT NULL)
      )
    )
  ),
  CHECK (status != 'succeeded' OR error IS NULL),
  -- A run is superseded instead of materialized, so it carries no failure, and only replacement
  -- runs can be: telemetry appends readings rather than replace a source.
  CHECK (status != 'superseded' OR (error IS NULL AND materialization_protocol = 'replacement')),
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
  CHECK (projection_kind != 'telemetry' OR status != 'succeeded' OR input_exhausted = 1)
);

INSERT INTO projection_runs_v2 (
  project_id, id, execution_id, projection_id, projection_kind, materialization_protocol,
  dataset_id, dataset_version_id, dataset_version_created_at, ontology_revision,
  projection_revision, ownership_hash, object_type_id, source_object_type_id,
  target_object_type_id, status, queued_at, started_at, finished_at, attempt, execution_token,
  fixed_batch_size, next_batch_ordinal, next_row_offset, input_exhausted,
  missing_target_object_type_id, missing_target_object_id, missing_target_batch_ordinal,
  missing_target_first_seen_at, source_rows_read, source_rows_skipped, source_changes_read, error
)
SELECT
  project_id, id, execution_id, projection_id, projection_kind, materialization_protocol,
  dataset_id, dataset_version_id, dataset_version_created_at, ontology_revision,
  projection_revision, ownership_hash, object_type_id, source_object_type_id,
  target_object_type_id, status, queued_at, started_at, finished_at, attempt, execution_token,
  fixed_batch_size, next_batch_ordinal, next_row_offset, input_exhausted,
  missing_target_object_type_id, missing_target_object_id, missing_target_batch_ordinal,
  missing_target_first_seen_at, source_rows_read, source_rows_skipped, source_changes_read, error
FROM projection_runs;

DROP TABLE projection_runs;
ALTER TABLE projection_runs_v2 RENAME TO projection_runs;

CREATE INDEX idx_projection_runs_project_started
  ON projection_runs(project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_projection_started
  ON projection_runs(project_id, projection_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_dataset_started
  ON projection_runs(project_id, dataset_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_version_started
  ON projection_runs(project_id, dataset_version_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_status_started
  ON projection_runs(project_id, status, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_projection_runs_project_object_type_started
  ON projection_runs(project_id, object_type_id, COALESCE(started_at, queued_at) DESC);
