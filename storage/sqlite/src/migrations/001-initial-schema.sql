CREATE TABLE objects (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  properties TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  last_commit_id TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, primary_id)
);

CREATE INDEX idx_objects_project_type
  ON objects(project_id, object_type_id);
CREATE INDEX idx_objects_updated_at
  ON objects(project_id, object_type_id, updated_at);
CREATE INDEX idx_objects_created_at
  ON objects(project_id, object_type_id, created_at);

CREATE TABLE links (
  project_id TEXT NOT NULL,
  source_type_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  properties TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_commit_id TEXT NOT NULL,
  PRIMARY KEY (project_id, source_type_id, source_id, link_id, target_type_id, target_id)
);

CREATE INDEX idx_links_source
  ON links(project_id, source_type_id, source_id);
CREATE INDEX idx_links_target
  ON links(project_id, target_type_id, target_id);

CREATE TABLE timeseries (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  at TEXT NOT NULL,
  last_commit_id TEXT NOT NULL,
  -- A telemetry point's identity is (series, at): one value per instant per
  -- series. Appends upsert on this key (ON CONFLICT targets these columns), so
  -- no separate idempotency ledger is needed. This primary-key index also serves
  -- point lookups and latest-value reads (equality on the series prefix +
  -- range/backward scan on `at`), so no additional timeseries indexes.
  PRIMARY KEY (project_id, object_type_id, object_id, property_id, at)
);

CREATE TABLE sync_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_read INTEGER CHECK (rows_read IS NULL OR rows_read >= 0),
  output_version_id TEXT,
  expected_latest_version_id TEXT,
  commit_message TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  checkpoint TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_sync_runs_project_started
  ON sync_runs(project_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_dataset_started
  ON sync_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_sync_started
  ON sync_runs(project_id, sync_id, started_at DESC);
CREATE INDEX idx_sync_runs_project_status_started
  ON sync_runs(project_id, status, started_at DESC);

CREATE TABLE projection_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link', 'telemetry')),
  materialization_protocol TEXT NOT NULL CHECK (materialization_protocol IN ('replacement', 'telemetry')),
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  dataset_version_created_at TEXT NOT NULL,
  ontology_revision TEXT NOT NULL,
  projection_revision TEXT NOT NULL,
  ownership_hash TEXT NOT NULL,
  object_type_id TEXT,
  source_object_type_id TEXT,
  target_object_type_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
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
  CHECK (source_rows_skipped <= source_rows_read),
  CHECK ((status = 'running') = (finished_at IS NULL)),
  CHECK ((status = 'running') = (execution_token IS NOT NULL)),
  CHECK ((projection_kind = 'telemetry') = (materialization_protocol = 'telemetry')),
  CHECK (
    (
      projection_kind = 'link'
      AND object_type_id IS NULL
      AND source_object_type_id IS NOT NULL
      AND target_object_type_id IS NOT NULL
    )
    OR
    (
      projection_kind IN ('object', 'telemetry')
      AND object_type_id IS NOT NULL
      AND source_object_type_id IS NULL
      AND target_object_type_id IS NULL
    )
  ),
  CHECK (
    (
      materialization_protocol = 'replacement'
      AND fixed_batch_size IS NULL
      AND next_batch_ordinal IS NULL
      AND next_row_offset IS NULL
      AND input_exhausted IS NULL
    )
    OR
    (
      materialization_protocol = 'telemetry'
      AND fixed_batch_size IS NOT NULL
      AND next_batch_ordinal IS NOT NULL
      AND next_row_offset IS NOT NULL
      AND input_exhausted IS NOT NULL
    )
  ),
  CHECK (
    (
      missing_target_object_type_id IS NULL
      AND missing_target_object_id IS NULL
      AND missing_target_batch_ordinal IS NULL
      AND missing_target_first_seen_at IS NULL
    )
    OR
    (
      projection_kind = 'telemetry'
      AND missing_target_object_type_id = object_type_id
      AND missing_target_object_id IS NOT NULL
      AND missing_target_batch_ordinal = next_batch_ordinal
      AND missing_target_first_seen_at IS NOT NULL
    )
  ),
  CHECK (projection_kind != 'telemetry' OR status != 'succeeded' OR input_exhausted = 1)
);

CREATE INDEX idx_projection_runs_project_started
  ON projection_runs(project_id, started_at DESC);
CREATE INDEX idx_projection_runs_project_projection_started
  ON projection_runs(project_id, projection_id, started_at DESC);
CREATE INDEX idx_projection_runs_project_dataset_started
  ON projection_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX idx_projection_runs_project_version_started
  ON projection_runs(project_id, dataset_version_id, started_at DESC);
CREATE INDEX idx_projection_runs_project_status_started
  ON projection_runs(project_id, status, started_at DESC);
CREATE INDEX idx_projection_runs_project_object_type_started
  ON projection_runs(project_id, object_type_id, started_at DESC);

-- Ontology tables deliberately omit IF NOT EXISTS. A fresh installation is the only supported
-- schema for this coordinated breaking release; an untracked legacy schema must fail atomically.
CREATE TABLE ontology_commits (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('action', 'runtime', 'projection', 'telemetry')),
  origin_run_id TEXT,
  origin_batch_ordinal INTEGER CHECK (
    origin_batch_ordinal IS NULL OR origin_batch_ordinal >= 0
  ),
  origin TEXT NOT NULL CHECK (json_valid(origin)),
  actor TEXT CHECK (actor IS NULL OR json_valid(actor)),
  ontology_revision TEXT NOT NULL,
  projection_revision TEXT,
  ownership_hash TEXT,
  intent TEXT NOT NULL CHECK (json_valid(intent)),
  result TEXT NOT NULL CHECK (json_valid(result)),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, idempotency_key),
  CHECK (
    (origin_kind IN ('action', 'projection') AND origin_run_id IS NOT NULL AND origin_batch_ordinal IS NULL)
    OR (origin_kind = 'telemetry' AND (
      (origin_run_id IS NULL AND origin_batch_ordinal IS NULL)
      OR (origin_run_id IS NOT NULL AND origin_batch_ordinal IS NOT NULL)
    ))
    OR (origin_kind = 'runtime' AND origin_run_id IS NULL AND origin_batch_ordinal IS NULL)
  )
);

CREATE UNIQUE INDEX idx_ontology_commits_action_origin
  ON ontology_commits(project_id, origin_run_id)
  WHERE origin_kind = 'action';
CREATE UNIQUE INDEX idx_ontology_commits_projection_origin
  ON ontology_commits(project_id, origin_run_id)
  WHERE origin_kind = 'projection';
CREATE UNIQUE INDEX idx_ontology_commits_telemetry_origin
  ON ontology_commits(project_id, origin_run_id, origin_batch_ordinal)
  WHERE origin_kind = 'telemetry' AND origin_run_id IS NOT NULL;
CREATE INDEX idx_ontology_commits_history
  ON ontology_commits(project_id, committed_at, id);
CREATE INDEX idx_ontology_commits_origin
  ON ontology_commits(project_id, origin_kind, origin_run_id, origin_batch_ordinal);

CREATE TABLE ontology_sources (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  projection_run_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link')),
  protocol TEXT NOT NULL CHECK (protocol = 'replacement'),
  status TEXT NOT NULL CHECK (
    status IN ('staging', 'ready', 'active', 'superseded', 'abandoned')
  ),
  execution_token TEXT,
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  dataset_version_created_at TEXT NOT NULL,
  projection_revision TEXT NOT NULL,
  ownership_hash TEXT NOT NULL,
  ontology_revision TEXT NOT NULL,
  root_count INTEGER CHECK (root_count IS NULL OR root_count >= 0),
  assertion_count INTEGER CHECK (assertion_count IS NULL OR assertion_count >= 0),
  created_at TEXT NOT NULL,
  ready_at TEXT,
  activated_at TEXT,
  terminal_at TEXT,
  last_commit_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, source_id, materialization_id),
  CHECK ((root_count IS NULL) = (assertion_count IS NULL)),
  CHECK ((root_count IS NULL) = (ready_at IS NULL)),
  CHECK ((status IN ('staging', 'ready')) = (execution_token IS NOT NULL)),
  CHECK (
    (status = 'staging' AND ready_at IS NULL)
    OR (status IN ('ready', 'active', 'superseded') AND ready_at IS NOT NULL)
    OR status = 'abandoned'
  ),
  CHECK ((status IN ('active', 'superseded')) = (activated_at IS NOT NULL)),
  CHECK ((status IN ('active', 'superseded')) = (last_commit_id IS NOT NULL)),
  CHECK ((status IN ('superseded', 'abandoned')) = (terminal_at IS NOT NULL)),
  CHECK (ready_at IS NULL OR created_at <= ready_at),
  CHECK (activated_at IS NULL OR (ready_at IS NOT NULL AND ready_at <= activated_at)),
  CHECK (terminal_at IS NULL OR created_at <= terminal_at),
  CHECK (terminal_at IS NULL OR ready_at IS NULL OR ready_at <= terminal_at),
  CHECK (terminal_at IS NULL OR activated_at IS NULL OR activated_at <= terminal_at),
  CHECK (created_at <= updated_at)
);

CREATE UNIQUE INDEX idx_ontology_sources_active
  ON ontology_sources(project_id, source_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX idx_ontology_sources_run_candidate
  ON ontology_sources(project_id, projection_run_id)
  WHERE status IN ('staging', 'ready');
CREATE INDEX idx_ontology_sources_cleanup
  ON ontology_sources(project_id, status, terminal_at, source_id, materialization_id);
CREATE INDEX idx_ontology_sources_run
  ON ontology_sources(project_id, projection_run_id);

CREATE TABLE ontology_source_rows (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  materialization_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  entity_key TEXT NOT NULL CHECK (json_valid(entity_key)),
  entity_sort_key TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('object', 'link')),
  root_key TEXT NOT NULL CHECK (json_valid(root_key)),
  root_sort_key TEXT NOT NULL,
  staging_ordinal INTEGER NOT NULL CHECK (staging_ordinal >= 0),
  root TEXT NOT NULL CHECK (json_valid(root)),
  assertion TEXT NOT NULL CHECK (json_valid(assertion)),
  object_type_id TEXT,
  primary_id TEXT,
  source_type_id TEXT,
  source_primary_id TEXT,
  link_id TEXT,
  target_type_id TEXT,
  target_primary_id TEXT,
  root_object_type_id TEXT,
  root_primary_id TEXT,
  root_source_type_id TEXT,
  root_source_primary_id TEXT,
  root_link_id TEXT,
  root_target_type_id TEXT,
  root_target_primary_id TEXT,
  PRIMARY KEY (project_id, source_id, materialization_id, entity_kind, entity_key),
  FOREIGN KEY (project_id, source_id, materialization_id)
    REFERENCES ontology_sources(project_id, source_id, materialization_id)
    ON DELETE RESTRICT,
  CHECK (
    (entity_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL
      AND source_type_id IS NULL AND source_primary_id IS NULL AND link_id IS NULL
      AND target_type_id IS NULL AND target_primary_id IS NULL)
    OR
    (entity_kind = 'link' AND object_type_id IS NULL AND primary_id IS NULL
      AND source_type_id IS NOT NULL AND source_primary_id IS NOT NULL AND link_id IS NOT NULL
      AND target_type_id IS NOT NULL AND target_primary_id IS NOT NULL)
  ),
  CHECK (
    (root_kind = 'object' AND root_object_type_id IS NOT NULL AND root_primary_id IS NOT NULL
      AND root_source_type_id IS NULL AND root_source_primary_id IS NULL AND root_link_id IS NULL
      AND root_target_type_id IS NULL AND root_target_primary_id IS NULL)
    OR
    (root_kind = 'link' AND root_object_type_id IS NULL AND root_primary_id IS NULL
      AND root_source_type_id IS NOT NULL AND root_source_primary_id IS NOT NULL
      AND root_link_id IS NOT NULL AND root_target_type_id IS NOT NULL
      AND root_target_primary_id IS NOT NULL)
  )
);

CREATE INDEX idx_ontology_source_rows_root
  ON ontology_source_rows(
    project_id, source_id, materialization_id, root_sort_key, staging_ordinal, entity_sort_key
  );
CREATE INDEX idx_ontology_source_rows_staging_ordinal
  ON ontology_source_rows(project_id, source_id, materialization_id, staging_ordinal);
CREATE INDEX idx_ontology_source_rows_entity_sort
  ON ontology_source_rows(project_id, source_id, materialization_id, entity_sort_key);
CREATE INDEX idx_ontology_source_rows_object
  ON ontology_source_rows(project_id, object_type_id, primary_id)
  WHERE entity_kind = 'object';
CREATE INDEX idx_ontology_source_rows_link_source
  ON ontology_source_rows(
    project_id, source_type_id, source_primary_id, link_id,
    target_type_id, target_primary_id
  )
  WHERE entity_kind = 'link';
CREATE INDEX idx_ontology_source_rows_link_target
  ON ontology_source_rows(project_id, target_type_id, target_primary_id)
  WHERE entity_kind = 'link';

CREATE TABLE ontology_overrides (
  project_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('object', 'link')),
  entity_key TEXT NOT NULL CHECK (json_valid(entity_key)),
  entity_sort_key TEXT NOT NULL,
  object_type_id TEXT,
  primary_id TEXT,
  source_type_id TEXT,
  source_primary_id TEXT,
  link_id TEXT,
  target_type_id TEXT,
  target_primary_id TEXT,
  value TEXT NOT NULL CHECK (json_valid(value)),
  last_commit_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, entity_kind, entity_key),
  CHECK (
    (entity_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL
      AND source_type_id IS NULL AND source_primary_id IS NULL AND link_id IS NULL
      AND target_type_id IS NULL AND target_primary_id IS NULL)
    OR
    (entity_kind = 'link' AND object_type_id IS NULL AND primary_id IS NULL
      AND source_type_id IS NOT NULL AND source_primary_id IS NOT NULL AND link_id IS NOT NULL
      AND target_type_id IS NOT NULL AND target_primary_id IS NOT NULL)
  )
);

CREATE INDEX idx_ontology_overrides_link_source
  ON ontology_overrides(
    project_id, source_type_id, source_primary_id, link_id,
    target_type_id, target_primary_id
  )
  WHERE entity_kind = 'link';
CREATE INDEX idx_ontology_overrides_link_target
  ON ontology_overrides(project_id, target_type_id, target_primary_id)
  WHERE entity_kind = 'link';
CREATE INDEX idx_ontology_overrides_object
  ON ontology_overrides(project_id, object_type_id, primary_id)
  WHERE entity_kind = 'object';

CREATE TABLE ontology_outbox (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  commit_ordinal INTEGER NOT NULL CHECK (commit_ordinal >= 0),
  envelope TEXT NOT NULL CHECK (json_valid(envelope)),
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id TEXT,
  lease_expires_at TEXT,
  published_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, commit_id, commit_ordinal),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX idx_ontology_outbox_claim
  ON ontology_outbox(project_id, available_at, lease_expires_at, created_at, commit_id, commit_ordinal)
  WHERE published_at IS NULL;
CREATE INDEX idx_ontology_outbox_published
  ON ontology_outbox(project_id, published_at, id)
  WHERE published_at IS NOT NULL;

CREATE TABLE pipeline_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  output_dataset_id TEXT,
  output_version_id TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_pipeline_runs_project_started
  ON pipeline_runs(project_id, started_at DESC);
CREATE INDEX idx_pipeline_runs_project_pipeline_started
  ON pipeline_runs(project_id, pipeline_id, started_at DESC);
CREATE INDEX idx_pipeline_runs_project_status_started
  ON pipeline_runs(project_id, status, started_at DESC);

CREATE TABLE pipeline_step_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pipeline_run_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  inputs TEXT NOT NULL,
  output_version_id TEXT,
  rows_written INTEGER CHECK (rows_written IS NULL OR rows_written >= 0),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_pipeline_step_runs_project_started
  ON pipeline_step_runs(project_id, started_at DESC);
CREATE INDEX idx_pipeline_step_runs_project_run_started
  ON pipeline_step_runs(project_id, pipeline_run_id, started_at DESC);
CREATE INDEX idx_pipeline_step_runs_project_pipeline_started
  ON pipeline_step_runs(project_id, pipeline_id, started_at DESC);
CREATE INDEX idx_pipeline_step_runs_project_step_started
  ON pipeline_step_runs(project_id, step_id, started_at DESC);
CREATE INDEX idx_pipeline_step_runs_project_dataset_started
  ON pipeline_step_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX idx_pipeline_step_runs_project_status_started
  ON pipeline_step_runs(project_id, status, started_at DESC);

CREATE TABLE workflow_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
  ),
  input TEXT NOT NULL,
  queued_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  source TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  requested_by_principal_type TEXT NOT NULL DEFAULT 'system'
    CHECK (requested_by_principal_type IN ('user', 'serviceAccount', 'system')),
  requested_by_principal_id TEXT NOT NULL DEFAULT 'system',
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_workflow_runs_project_started
  ON workflow_runs(project_id, started_at DESC);
CREATE INDEX idx_workflow_runs_project_workflow_started
  ON workflow_runs(project_id, workflow_id, started_at DESC);
CREATE INDEX idx_workflow_runs_project_status_started
  ON workflow_runs(project_id, status, started_at DESC);

CREATE TABLE workflow_node_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_index INTEGER NOT NULL CHECK (node_index >= 0),
  node_type TEXT NOT NULL CHECK (node_type IN ('step', 'action', 'intervention', 'agent')),
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  output TEXT,
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_workflow_node_runs_project_started
  ON workflow_node_runs(project_id, started_at DESC);
CREATE INDEX idx_workflow_node_runs_project_run_started
  ON workflow_node_runs(project_id, workflow_run_id, started_at DESC);
CREATE INDEX idx_workflow_node_runs_project_workflow_started
  ON workflow_node_runs(project_id, workflow_id, started_at DESC);
CREATE INDEX idx_workflow_node_runs_project_node_started
  ON workflow_node_runs(project_id, node_id, started_at DESC);
CREATE INDEX idx_workflow_node_runs_project_key_started
  ON workflow_node_runs(project_id, node_key, started_at DESC);
CREATE INDEX idx_workflow_node_runs_project_status_started
  ON workflow_node_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_agent_node_runs (
  project_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  prompt TEXT NOT NULL,
  execution_principal_type TEXT
    CHECK (execution_principal_type IS NULL OR execution_principal_type = 'serviceAccount'),
  execution_principal_id TEXT,
  model_id TEXT,
  finish_reason TEXT,
  usage TEXT,
  trace TEXT,
  diagnostics TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, node_run_id),
  FOREIGN KEY (project_id, node_run_id)
    REFERENCES workflow_node_runs (project_id, id)
    ON DELETE CASCADE,
  CHECK ((execution_principal_type IS NULL) = (execution_principal_id IS NULL)),
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_workflow_agent_node_runs_project_agent_created
  ON workflow_agent_node_runs(project_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_agent_node_runs_project_status_created
  ON workflow_agent_node_runs(project_id, status, created_at DESC);

CREATE TABLE workflow_interventions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  node_index INTEGER NOT NULL CHECK (node_index >= 0),
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  intervention_id TEXT NOT NULL,
  input TEXT NOT NULL,
  default_response TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'cancelled', 'expired')),
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  submitted_at TEXT,
  submitted_by TEXT,
  response TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  expired_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_workflow_interventions_project_requested
  ON workflow_interventions(project_id, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_status_requested
  ON workflow_interventions(project_id, status, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_workflow_requested
  ON workflow_interventions(project_id, workflow_id, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_run_requested
  ON workflow_interventions(project_id, workflow_run_id, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_node_run_requested
  ON workflow_interventions(project_id, node_run_id, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_node_requested
  ON workflow_interventions(project_id, node_id, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_key_requested
  ON workflow_interventions(project_id, node_key, requested_at DESC);
CREATE INDEX idx_workflow_interventions_project_intervention_requested
  ON workflow_interventions(project_id, intervention_id, requested_at DESC);

CREATE TABLE webhook_deliveries (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  received_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  error TEXT,
  PRIMARY KEY (project_id, connector_id, webhook_id, idempotency_key)
);

CREATE INDEX idx_webhook_deliveries_project_received
  ON webhook_deliveries(project_id, received_at DESC);

CREATE TABLE webhook_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  request_body_bytes INTEGER CHECK (request_body_bytes IS NULL OR request_body_bytes >= 0),
  response_status INTEGER CHECK (
    response_status IS NULL OR (response_status >= 100 AND response_status <= 599)
  ),
  idempotency_key TEXT,
  delivery_claim_result TEXT CHECK (
    delivery_claim_result IS NULL OR delivery_claim_result IN ('claimed', 'duplicate', 'in_progress')
  ),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_webhook_runs_project_started
  ON webhook_runs(project_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_connector_started
  ON webhook_runs(project_id, connector_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_webhook_started
  ON webhook_runs(project_id, connector_id, webhook_id, started_at DESC);
CREATE INDEX idx_webhook_runs_project_status_started
  ON webhook_runs(project_id, status, started_at DESC);
CREATE INDEX idx_webhook_runs_project_idempotency
  ON webhook_runs(project_id, idempotency_key);

CREATE TABLE rule_states (
  project_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('object')),
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  PRIMARY KEY (project_id, rule_id, subject_kind, object_type_id, primary_id)
);

CREATE INDEX idx_rule_states_project_rule
  ON rule_states(project_id, rule_id);

CREATE TABLE action_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('none', 'object')),
  object_type_id TEXT,
  primary_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  phase TEXT CHECK (
    phase IS NULL OR phase IN (
      'request',
      'enqueue',
      'validation',
      'writeback',
      'edits',
      'commit',
      'effects',
      'cancelled'
    )
  ),
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  params TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  writeback_status TEXT CHECK (writeback_status IS NULL OR writeback_status IN ('succeeded', 'failed')),
  writeback_completed_at TEXT,
  writeback_result TEXT,
  writeback_error TEXT CHECK (writeback_error IS NULL OR json_valid(writeback_error)),
  effects_status TEXT CHECK (effects_status IS NULL OR effects_status IN ('succeeded', 'failed')),
  effects_completed_at TEXT,
  effects_error TEXT CHECK (effects_error IS NULL OR json_valid(effects_error)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  CHECK (
    (subject_kind = 'none' AND object_type_id IS NULL AND primary_id IS NULL)
    OR (subject_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL)
  ),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_action_runs_project_started
  ON action_runs(project_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_action_runs_project_action_started
  ON action_runs(project_id, action_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_action_runs_project_object_started
  ON action_runs(project_id, object_type_id, primary_id, COALESCE(started_at, queued_at) DESC);
CREATE INDEX idx_action_runs_project_status_started
  ON action_runs(project_id, status, COALESCE(started_at, queued_at) DESC);

CREATE TABLE auth_users (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE UNIQUE INDEX idx_auth_users_project_email
  ON auth_users(project_id, email);
CREATE INDEX idx_auth_users_project_status_created
  ON auth_users(project_id, status, created_at DESC);
CREATE INDEX idx_auth_users_project_created
  ON auth_users(project_id, created_at DESC);

CREATE TABLE auth_user_identities (
  project_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claims TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, strategy_id, subject)
);

CREATE INDEX idx_auth_user_identities_user
  ON auth_user_identities(project_id, user_id);

CREATE TABLE auth_service_accounts (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_by_principal_type TEXT CHECK (
    created_by_principal_type IS NULL
      OR created_by_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  created_by_principal_id TEXT,
  created_by_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_auth_service_accounts_project_status_created
  ON auth_service_accounts(project_id, status, created_at DESC);
CREATE INDEX idx_auth_service_accounts_project_created
  ON auth_service_accounts(project_id, created_at DESC);

CREATE TABLE auth_service_account_group_memberships (
  project_id TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, service_account_id, group_id)
);

CREATE INDEX idx_auth_service_account_group_memberships_group
  ON auth_service_account_group_memberships(project_id, group_id);

CREATE TABLE auth_sessions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT,
  revoked_at TEXT,
  last_seen_at TEXT,
  user_agent TEXT,
  ip_address TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_auth_sessions_user_active
  ON auth_sessions(project_id, user_id, audience, revoked_at, expires_at);
CREATE INDEX idx_auth_sessions_token
  ON auth_sessions(project_id, id, token_hash);

CREATE TABLE auth_access_tokens (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'serviceAccount')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'serviceAccount')),
  subject_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  group_ids TEXT,
  created_by_principal_type TEXT CHECK (
    created_by_principal_type IS NULL
      OR created_by_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  created_by_principal_id TEXT,
  created_by_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT,
  last_used_user_agent TEXT,
  last_used_ip_address TEXT,
  PRIMARY KEY (project_id, id),
  CHECK (
    (kind = 'personal' AND subject_type = 'user')
      OR (kind = 'serviceAccount' AND subject_type = 'serviceAccount')
  )
);

CREATE INDEX idx_auth_access_tokens_lookup
  ON auth_access_tokens(project_id, id, kind, token_hash, revoked_at, expires_at);
CREATE INDEX idx_auth_access_tokens_subject_created
  ON auth_access_tokens(project_id, subject_type, subject_id, created_at DESC);

CREATE TABLE auth_invitations (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by_principal_type TEXT CHECK (
    created_by_principal_type IS NULL
      OR created_by_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  created_by_principal_id TEXT,
  created_by_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_auth_invitations_project_email
  ON auth_invitations(project_id, email, status, expires_at);
CREATE INDEX idx_auth_invitations_project_status_created
  ON auth_invitations(project_id, status, created_at DESC);

CREATE TABLE auth_invitation_groups (
  project_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (project_id, invitation_id, group_id)
);

CREATE INDEX idx_auth_invitation_groups_group
  ON auth_invitation_groups(project_id, group_id);
CREATE INDEX idx_auth_invitation_groups_invitation_position
  ON auth_invitation_groups(project_id, invitation_id, position);

CREATE TABLE auth_group_memberships (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual', 'agent')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, group_id)
);

CREATE INDEX idx_auth_group_memberships_group
  ON auth_group_memberships(project_id, group_id);

CREATE TABLE auth_magic_links (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_auth_magic_links_email_active
  ON auth_magic_links(project_id, email, consumed_at, revoked_at, expires_at);

CREATE TABLE auth_oidc_authorization_attempts (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  state_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_auth_oidc_attempts_active
  ON auth_oidc_authorization_attempts(project_id, strategy_id, consumed_at, expires_at);

CREATE TABLE agent_threads (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_principal_type TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  active_run_id TEXT,
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX idx_agent_threads_project_activity
  ON agent_threads(project_id, COALESCE(last_message_at, created_at) DESC);
CREATE INDEX idx_agent_threads_project_agent_activity
  ON agent_threads(project_id, agent_id, COALESCE(last_message_at, created_at) DESC);
CREATE INDEX idx_agent_threads_project_status_activity
  ON agent_threads(project_id, status, COALESCE(last_message_at, created_at) DESC);
CREATE INDEX idx_agent_threads_project_owner_activity
  ON agent_threads(project_id, owner_principal_type, owner_principal_id, COALESCE(last_message_at, created_at) DESC);

CREATE TABLE agent_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  requested_by_principal_type TEXT NOT NULL DEFAULT 'system' CHECK (
    requested_by_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  requested_by_principal_id TEXT NOT NULL DEFAULT 'system',
  execution_principal_type TEXT CHECK (
    execution_principal_type IS NULL OR execution_principal_type = 'serviceAccount'
  ),
  execution_principal_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  model_id TEXT,
  finish_reason TEXT,
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
  usage_reasoning_tokens INTEGER CHECK (usage_reasoning_tokens IS NULL OR usage_reasoning_tokens >= 0),
  usage_cached_input_tokens INTEGER CHECK (
    usage_cached_input_tokens IS NULL OR usage_cached_input_tokens >= 0
  ),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  diagnostics TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  CHECK (
    (execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_agent_runs_project_started
  ON agent_runs(project_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs(project_id, thread_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_agent_started
  ON agent_runs(project_id, agent_id, COALESCE(started_at, created_at) DESC);
CREATE INDEX idx_agent_runs_project_status_started
  ON agent_runs(project_id, status, COALESCE(started_at, created_at) DESC);

CREATE TABLE agent_messages (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  author_principal_type TEXT CHECK (
    author_principal_type IS NULL OR author_principal_type IN ('user', 'serviceAccount', 'system')
  ),
  author_principal_id TEXT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  parts TEXT NOT NULL,
  metadata TEXT,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE UNIQUE INDEX idx_agent_messages_thread_seq
  ON agent_messages(project_id, thread_id, seq);
CREATE INDEX idx_agent_messages_project_thread_role
  ON agent_messages(project_id, thread_id, role, seq);
