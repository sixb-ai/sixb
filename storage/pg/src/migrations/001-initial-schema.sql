CREATE TABLE IF NOT EXISTS objects (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  properties JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL,
  source_event_id TEXT,
  PRIMARY KEY (project_id, object_type_id, primary_id)
);

CREATE INDEX IF NOT EXISTS idx_objects_project_type
  ON objects (project_id, object_type_id);
CREATE INDEX IF NOT EXISTS idx_objects_updated_at
  ON objects (project_id, object_type_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_objects_created_at
  ON objects (project_id, object_type_id, created_at);
CREATE INDEX IF NOT EXISTS idx_objects_properties
  ON objects USING GIN (properties);

CREATE TABLE IF NOT EXISTS links (
  project_id TEXT NOT NULL,
  source_type_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  properties JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_event_id TEXT,
  PRIMARY KEY (project_id, source_type_id, source_id, link_id, target_type_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_links_source
  ON links (project_id, source_type_id, source_id);
CREATE INDEX IF NOT EXISTS idx_links_target
  ON links (project_id, target_type_id, target_id);

CREATE TABLE IF NOT EXISTS timeseries (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value JSONB NOT NULL,
  unit TEXT,
  at TIMESTAMPTZ NOT NULL,
  source_event_id TEXT NOT NULL,
  -- A telemetry point's identity is (series, at): one value per instant per
  -- series. Appends upsert on this key, so no separate idempotency ledger is
  -- needed. This primary-key index also serves point lookups and latest-value
  -- reads (equality on the series prefix + range/backward scan on `at`), so no
  -- additional timeseries indexes are required.
  PRIMARY KEY (project_id, object_type_id, object_id, property_id, at)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  rows_read INTEGER CHECK (rows_read IS NULL OR rows_read >= 0),
  output_version_id TEXT,
  expected_latest_version_id TEXT,
  commit_message TEXT,
  error_name TEXT,
  error_message TEXT,
  checkpoint JSONB,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_project_started
  ON sync_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_dataset_started
  ON sync_runs (project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_sync_started
  ON sync_runs (project_id, sync_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_status_started
  ON sync_runs (project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  output_dataset_id TEXT,
  output_version_id TEXT,
  error_name TEXT,
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_started
  ON pipeline_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_pipeline_started
  ON pipeline_runs (project_id, pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_status_started
  ON pipeline_runs (project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_step_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pipeline_run_id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'append')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  inputs JSONB NOT NULL,
  output_version_id TEXT,
  rows_written INTEGER CHECK (rows_written IS NULL OR rows_written >= 0),
  error_name TEXT,
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE IF NOT EXISTS projection_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link', 'telemetry')),
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  object_type_id TEXT,
  source_object_type_id TEXT,
  target_object_type_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  rows_processed INTEGER NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
  rows_skipped INTEGER NOT NULL DEFAULT 0 CHECK (rows_skipped >= 0),
  objects_upserted INTEGER NOT NULL DEFAULT 0 CHECK (objects_upserted >= 0),
  links_upserted INTEGER NOT NULL DEFAULT 0 CHECK (links_upserted >= 0),
  telemetry_points_appended INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_points_appended >= 0),
  telemetry_points_skipped INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_points_skipped >= 0),
  telemetry_rows_failed INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_rows_failed >= 0),
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_started
  ON pipeline_step_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_run_started
  ON pipeline_step_runs (project_id, pipeline_run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_pipeline_started
  ON pipeline_step_runs (project_id, pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_step_started
  ON pipeline_step_runs (project_id, step_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_dataset_started
  ON pipeline_step_runs (project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_status_started
  ON pipeline_step_runs (project_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_projection_runs_project_started
  ON projection_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_projection_started
  ON projection_runs (project_id, projection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_dataset_started
  ON projection_runs (project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_version_started
  ON projection_runs (project_id, dataset_version_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_status_started
  ON projection_runs (project_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_object_type_started
  ON projection_runs (project_id, object_type_id, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')
  ),
  input JSONB NOT NULL,
  queued_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  error TEXT,
  source JSONB,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_started
  ON workflow_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_workflow_started
  ON workflow_runs (project_id, workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_status_started
  ON workflow_runs (project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_node_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_index INTEGER NOT NULL CHECK (node_index >= 0),
  node_type TEXT NOT NULL CHECK (node_type IN ('step', 'action', 'intervention')),
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  input JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  output JSONB,
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_started
  ON workflow_node_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_run_started
  ON workflow_node_runs (project_id, workflow_run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_workflow_started
  ON workflow_node_runs (project_id, workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_node_started
  ON workflow_node_runs (project_id, node_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_key_started
  ON workflow_node_runs (project_id, node_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_status_started
  ON workflow_node_runs (project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_interventions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  node_index INTEGER NOT NULL CHECK (node_index >= 0),
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  intervention_id TEXT NOT NULL,
  input JSONB NOT NULL,
  default_response JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'cancelled', 'expired')),
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  submitted_by JSONB,
  response JSONB,
  cancelled_at TIMESTAMPTZ,
  cancelled_by JSONB,
  expired_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_requested
  ON workflow_interventions (project_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_status_requested
  ON workflow_interventions (project_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_workflow_requested
  ON workflow_interventions (project_id, workflow_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_run_requested
  ON workflow_interventions (project_id, workflow_run_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_node_run_requested
  ON workflow_interventions (project_id, node_run_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_node_requested
  ON workflow_interventions (project_id, node_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_key_requested
  ON workflow_interventions (project_id, node_key, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_interventions_project_intervention_requested
  ON workflow_interventions (project_id, intervention_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
  received_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT,
  PRIMARY KEY (project_id, connector_id, webhook_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project_received
  ON webhook_deliveries (project_id, received_at DESC);

CREATE TABLE IF NOT EXISTS webhook_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  request_body_bytes INTEGER CHECK (request_body_bytes IS NULL OR request_body_bytes >= 0),
  response_status INTEGER CHECK (
    response_status IS NULL OR (response_status >= 100 AND response_status <= 599)
  ),
  idempotency_key TEXT,
  delivery_claim_result TEXT CHECK (
    delivery_claim_result IS NULL OR delivery_claim_result IN ('claimed', 'duplicate', 'in_progress')
  ),
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_started
  ON webhook_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_connector_started
  ON webhook_runs (project_id, connector_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_webhook_started
  ON webhook_runs (project_id, connector_id, webhook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_status_started
  ON webhook_runs (project_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_idempotency
  ON webhook_runs (project_id, idempotency_key);

CREATE TABLE IF NOT EXISTS rule_states (
  project_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('object')),
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, rule_id, subject_kind, object_type_id, primary_id)
);

CREATE INDEX IF NOT EXISTS idx_rule_states_project_rule
  ON rule_states (project_id, rule_id);

-- Object materialization dedupes re-applied events (object.upserted and
-- telemetry.appended) by id. Timeseries needs no equivalent ledger: its
-- (series, at) upsert is idempotent on its own.
CREATE TABLE IF NOT EXISTS applied_events_objects (
  event_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS action_runs (
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
  queued_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  params JSONB NOT NULL,
  idempotency_key TEXT NOT NULL,
  writeback_status TEXT CHECK (writeback_status IS NULL OR writeback_status IN ('succeeded', 'failed')),
  writeback_completed_at TIMESTAMPTZ,
  writeback_result JSONB,
  writeback_error_name TEXT,
  writeback_error_message TEXT,
  writeback_error_phase TEXT CHECK (
    writeback_error_phase IS NULL OR writeback_error_phase IN (
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
  effects_status TEXT CHECK (effects_status IS NULL OR effects_status IN ('succeeded', 'failed')),
  effects_completed_at TIMESTAMPTZ,
  effects_error_name TEXT,
  effects_error_message TEXT,
  effects_error_phase TEXT CHECK (
    effects_error_phase IS NULL OR effects_error_phase IN (
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
  error_name TEXT,
  error_message TEXT,
  error_phase TEXT CHECK (
    error_phase IS NULL OR error_phase IN (
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
  CHECK (
    (subject_kind = 'none' AND object_type_id IS NULL AND primary_id IS NULL)
    OR (subject_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL)
  ),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_action_runs_project_started
  ON action_runs (project_id, (COALESCE(started_at, queued_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_action_started
  ON action_runs (project_id, action_id, (COALESCE(started_at, queued_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_object_started
  ON action_runs (project_id, object_type_id, primary_id, (COALESCE(started_at, queued_at)) DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_status_started
  ON action_runs (project_id, status, (COALESCE(started_at, queued_at)) DESC);

CREATE TABLE IF NOT EXISTS action_run_commits (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, run_id)
);

CREATE TABLE IF NOT EXISTS action_run_object_diffs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  PRIMARY KEY (project_id, run_id, object_type_id, primary_id)
);

CREATE TABLE IF NOT EXISTS action_run_object_diff_properties (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, object_type_id, primary_id, property_id)
);

CREATE TABLE IF NOT EXISTS action_run_link_diffs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
  source_object_type_id TEXT NOT NULL,
  source_primary_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_object_type_id TEXT NOT NULL,
  target_primary_id TEXT NOT NULL,
  PRIMARY KEY (
    project_id,
    run_id,
    operation,
    source_object_type_id,
    source_primary_id,
    link_id,
    target_object_type_id,
    target_primary_id
  )
);

CREATE INDEX IF NOT EXISTS idx_action_run_object_diffs_object
  ON action_run_object_diffs (project_id, object_type_id, primary_id);
CREATE INDEX IF NOT EXISTS idx_action_run_link_diffs_source
  ON action_run_link_diffs (project_id, source_object_type_id, source_primary_id, link_id);
CREATE INDEX IF NOT EXISTS idx_action_run_link_diffs_target
  ON action_run_link_diffs (project_id, target_object_type_id, target_primary_id);

CREATE TABLE IF NOT EXISTS auth_users (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_project_email
  ON auth_users (project_id, email);
CREATE INDEX IF NOT EXISTS idx_auth_users_project_status_created
  ON auth_users (project_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_users_project_created
  ON auth_users (project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS auth_user_identities (
  project_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claims JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, strategy_id, subject),
  FOREIGN KEY (project_id, user_id)
    REFERENCES auth_users (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_user_identities_user
  ON auth_user_identities (project_id, user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, user_id)
    REFERENCES auth_users (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions (project_id, user_id, audience, expires_at DESC, created_at DESC, id DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_created
  ON auth_sessions (project_id, user_id, audience, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS auth_service_accounts (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  created_by_user_id TEXT,
  created_by_service_account_id TEXT,
  created_by_system_id TEXT,
  created_by_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id),
  CHECK (
    num_nonnulls(created_by_user_id, created_by_service_account_id, created_by_system_id) <= 1
  ),
  FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, created_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, created_by_session_id)
    REFERENCES auth_sessions (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_service_accounts_project_status_created
  ON auth_service_accounts (project_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_service_accounts_project_created
  ON auth_service_accounts (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_service_accounts_created_by_user
  ON auth_service_accounts (project_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_service_account_group_memberships (
  project_id TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, service_account_id, group_id),
  FOREIGN KEY (project_id, service_account_id)
    REFERENCES auth_service_accounts (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_service_account_group_memberships_group
  ON auth_service_account_group_memberships (project_id, group_id);

CREATE TABLE IF NOT EXISTS auth_access_tokens (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'serviceAccount')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'serviceAccount')),
  subject_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  group_ids JSONB,
  created_by_user_id TEXT,
  created_by_service_account_id TEXT,
  created_by_system_id TEXT,
  created_by_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  last_used_user_agent TEXT,
  last_used_ip_address TEXT,
  PRIMARY KEY (project_id, id),
  CHECK (
    (kind = 'personal' AND subject_type = 'user')
      OR (kind = 'serviceAccount' AND subject_type = 'serviceAccount')
  ),
  CHECK (
    num_nonnulls(created_by_user_id, created_by_service_account_id, created_by_system_id) <= 1
  ),
  FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, created_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, created_by_session_id)
    REFERENCES auth_sessions (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_lookup
  ON auth_access_tokens (project_id, id, kind, token_hash, expires_at DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auth_access_tokens_subject_created
  ON auth_access_tokens (project_id, subject_type, subject_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS auth_invitations (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by_user_id TEXT,
  created_by_service_account_id TEXT,
  created_by_system_id TEXT,
  created_by_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id),
  CHECK (
    num_nonnulls(created_by_user_id, created_by_service_account_id, created_by_system_id) <= 1
  ),
  FOREIGN KEY (project_id, created_by_user_id)
    REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, created_by_session_id)
    REFERENCES auth_sessions (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_invitations_project_email
  ON auth_invitations (project_id, email, status, expires_at DESC, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_invitations_project_status_created
  ON auth_invitations (project_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_invitations_pending_email
  ON auth_invitations (project_id, email, expires_at DESC, created_at DESC, id DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_auth_invitations_created_by_user
  ON auth_invitations (project_id, created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auth_invitations_created_by_session
  ON auth_invitations (project_id, created_by_session_id)
  WHERE created_by_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_invitation_groups (
  project_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (project_id, invitation_id, group_id),
  FOREIGN KEY (project_id, invitation_id)
    REFERENCES auth_invitations (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_invitation_groups_group
  ON auth_invitation_groups (project_id, group_id);
CREATE INDEX IF NOT EXISTS idx_auth_invitation_groups_invitation_position
  ON auth_invitation_groups (project_id, invitation_id, position);

CREATE TABLE IF NOT EXISTS auth_group_memberships (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, user_id, group_id),
  FOREIGN KEY (project_id, user_id)
    REFERENCES auth_users (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_group_memberships_group
  ON auth_group_memberships (project_id, group_id);

CREATE TABLE IF NOT EXISTS auth_magic_links (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_magic_links_email_active
  ON auth_magic_links (project_id, email, expires_at DESC, created_at DESC, id DESC)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_oidc_authorization_attempts (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  state_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_oidc_attempts_active
  ON auth_oidc_authorization_attempts (
    project_id,
    strategy_id,
    expires_at DESC,
    created_at DESC,
    id DESC
  )
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_threads (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_principal_type TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  active_run_id TEXT,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_project_activity
  ON agent_threads (project_id, (COALESCE(last_message_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_threads_project_agent_activity
  ON agent_threads (project_id, agent_id, (COALESCE(last_message_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_threads_project_status_activity
  ON agent_threads (project_id, status, (COALESCE(last_message_at, created_at)) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_threads_project_owner_activity
  ON agent_threads (
    project_id,
    owner_principal_type,
    owner_principal_id,
    (COALESCE(last_message_at, created_at)) DESC,
    id DESC
  );

CREATE TABLE IF NOT EXISTS agent_runs (
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
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  model_id TEXT,
  finish_reason TEXT,
  usage_input_tokens INTEGER CHECK (usage_input_tokens IS NULL OR usage_input_tokens >= 0),
  usage_output_tokens INTEGER CHECK (usage_output_tokens IS NULL OR usage_output_tokens >= 0),
  usage_total_tokens INTEGER CHECK (usage_total_tokens IS NULL OR usage_total_tokens >= 0),
  usage_reasoning_tokens INTEGER CHECK (
    usage_reasoning_tokens IS NULL OR usage_reasoning_tokens >= 0
  ),
  usage_cached_input_tokens INTEGER CHECK (
    usage_cached_input_tokens IS NULL OR usage_cached_input_tokens >= 0
  ),
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  lease_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_project_started
  ON agent_runs (project_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_thread_started
  ON agent_runs (project_id, thread_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_agent_started
  ON agent_runs (project_id, agent_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_status_started
  ON agent_runs (project_id, status, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
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
  parts JSONB NOT NULL,
  metadata JSONB,
  content_version INTEGER NOT NULL CHECK (content_version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_thread_seq
  ON agent_messages (project_id, thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_agent_messages_project_thread_role
  ON agent_messages (project_id, thread_id, role, seq);
