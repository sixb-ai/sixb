-- Dataset versions are first-class durable execution sources. Rebuild the parent table so the
-- source kind remains truthful instead of encoding a version as an event or synthetic execution.
CREATE TABLE executions_v2 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  executor_kind TEXT NOT NULL CHECK (
    executor_kind IN (
      'request', 'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow',
      'agent', 'kernel'
    )
  ),
  executor_id TEXT NOT NULL CHECK (length(trim(executor_id)) > 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution')
  ),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  requested_by_user_id TEXT,
  requested_by_service_account_id TEXT,
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  parent_execution_id TEXT,
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'kernel', 'disabled')
  ),
  authority_user_id TEXT,
  authority_service_account_id TEXT,
  authority_session_id TEXT,
  authority_access_token_id TEXT,
  authority_primitive_kind TEXT CHECK (
    authority_primitive_kind IS NULL
      OR authority_primitive_kind IN (
        'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow'
      )
  ),
  authority_primitive_id TEXT,
  authority_kernel_operation TEXT CHECK (
    authority_kernel_operation IS NULL OR authority_kernel_operation = 'ontology.recover'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  -- Keep the final table name here. Foreign-key rewriting is intentionally disabled while this
  -- parent table is rebuilt, so a reference to executions_v2 would survive the later rename.
  FOREIGN KEY (project_id, parent_execution_id) REFERENCES executions (project_id, id),
  FOREIGN KEY (project_id, requested_by_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, requested_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, authority_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_session_id) REFERENCES auth_sessions (project_id, id),
  FOREIGN KEY (project_id, authority_access_token_id)
    REFERENCES auth_access_tokens (project_id, id),
  CHECK ((requested_by_user_id IS NOT NULL) + (requested_by_service_account_id IS NOT NULL) <= 1),
  CHECK (
    (source_kind = 'execution' AND parent_execution_id = source_id)
      OR (source_kind <> 'execution' AND parent_execution_id IS NULL)
  ),
  CHECK (
    (
      authority_kind = 'principal'
      AND (authority_user_id IS NOT NULL) + (authority_service_account_id IS NOT NULL) = 1
      AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) <= 1
      AND (authority_session_id IS NULL OR authority_user_id IS NOT NULL)
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
    )
    OR (
      authority_kind = 'trustedPrimitive'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NOT NULL
      AND authority_primitive_id IS NOT NULL
      AND length(trim(authority_primitive_id)) > 0
      AND authority_kernel_operation IS NULL
    )
    OR (
      authority_kind = 'kernel'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NOT NULL
    )
    OR (
      authority_kind = 'disabled'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
    )
  ),
  CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS authority_user_id
          AND requested_by_service_account_id IS authority_service_account_id
        )
        OR (
          authority_kind = 'disabled'
          AND requested_by_user_id IS NULL
          AND requested_by_service_account_id IS NULL
        )
      )
    )
    OR (
      executor_kind IN ('action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow')
      AND authority_kind = 'trustedPrimitive'
      AND executor_kind = authority_primitive_kind
    )
    OR (
      executor_kind = 'agent'
      AND authority_kind = 'principal'
      AND authority_service_account_id IS NOT NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel')
  )
);

INSERT INTO executions_v2 SELECT * FROM executions;
DROP TABLE executions;
ALTER TABLE executions_v2 RENAME TO executions;

-- The migration step checks that projection_runs is empty before executing this schema rebuild:
-- legacy rows cannot be assigned honest execution authority.

DROP INDEX idx_projection_runs_project_started;
DROP INDEX idx_projection_runs_project_projection_started;
DROP INDEX idx_projection_runs_project_dataset_started;
DROP INDEX idx_projection_runs_project_version_started;
DROP INDEX idx_projection_runs_project_status_started;
DROP INDEX idx_projection_runs_project_object_type_started;

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
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  FOREIGN KEY (project_id, execution_id) REFERENCES executions (project_id, id) ON DELETE RESTRICT,
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
        (json_extract(error, '$.code') = 'queue.enqueue_failed'
          AND status = 'failed' AND attempt = 0 AND started_at IS NULL)
        OR (COALESCE(json_extract(error, '$.code'), '') != 'queue.enqueue_failed'
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
  CHECK (projection_kind != 'telemetry' OR status != 'succeeded' OR input_exhausted = 1)
);

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
