CREATE TABLE IF NOT EXISTS objects (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  properties TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  source_event_id TEXT,
  PRIMARY KEY (project_id, object_type_id, primary_id)
);

CREATE INDEX IF NOT EXISTS idx_objects_project_type
  ON objects(project_id, object_type_id);
CREATE INDEX IF NOT EXISTS idx_objects_updated_at
  ON objects(project_id, object_type_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_objects_created_at
  ON objects(project_id, object_type_id, created_at);

CREATE TABLE IF NOT EXISTS links (
  project_id TEXT NOT NULL,
  source_type_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  target_type_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  properties TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_event_id TEXT,
  PRIMARY KEY (project_id, source_type_id, source_id, link_id, target_type_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_links_source
  ON links(project_id, source_type_id, source_id);
CREATE INDEX IF NOT EXISTS idx_links_target
  ON links(project_id, target_type_id, target_id);

CREATE TABLE IF NOT EXISTS timeseries (
  project_id TEXT NOT NULL,
  object_type_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  value TEXT NOT NULL,
  unit TEXT,
  at TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  PRIMARY KEY (project_id, object_type_id, object_id, property_id, at, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_timeseries_lookup
  ON timeseries(project_id, object_type_id, object_id, property_id, at);
CREATE INDEX IF NOT EXISTS idx_timeseries_latest
  ON timeseries(project_id, object_type_id, object_id, property_id, at DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
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
  error_name TEXT,
  error_message TEXT,
  metadata TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_project_started
  ON sync_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_dataset_started
  ON sync_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_sync_started
  ON sync_runs(project_id, sync_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_project_status_started
  ON sync_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS projection_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN ('object', 'link')),
  dataset_id TEXT NOT NULL,
  dataset_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_processed INTEGER NOT NULL DEFAULT 0 CHECK (rows_processed >= 0),
  rows_skipped INTEGER NOT NULL DEFAULT 0 CHECK (rows_skipped >= 0),
  objects_upserted INTEGER NOT NULL DEFAULT 0 CHECK (objects_upserted >= 0),
  links_upserted INTEGER NOT NULL DEFAULT 0 CHECK (links_upserted >= 0),
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_projection_runs_project_started
  ON projection_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_projection_started
  ON projection_runs(project_id, projection_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_dataset_started
  ON projection_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_version_started
  ON projection_runs(project_id, dataset_version_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_projection_runs_project_status_started
  ON projection_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  output_dataset_id TEXT,
  output_version_id TEXT,
  error_name TEXT,
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_started
  ON pipeline_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_pipeline_started
  ON pipeline_runs(project_id, pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_project_status_started
  ON pipeline_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_step_runs (
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
  error_name TEXT,
  error_message TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_started
  ON pipeline_step_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_run_started
  ON pipeline_step_runs(project_id, pipeline_run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_pipeline_started
  ON pipeline_step_runs(project_id, pipeline_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_step_started
  ON pipeline_step_runs(project_id, step_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_dataset_started
  ON pipeline_step_runs(project_id, dataset_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_step_runs_project_status_started
  ON pipeline_step_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_started
  ON workflow_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_workflow_started
  ON workflow_runs(project_id, workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_project_status_started
  ON workflow_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS workflow_node_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  node_index INTEGER NOT NULL CHECK (node_index >= 0),
  node_type TEXT NOT NULL CHECK (node_type IN ('step', 'action')),
  node_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  output TEXT,
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_started
  ON workflow_node_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_run_started
  ON workflow_node_runs(project_id, workflow_run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_workflow_started
  ON workflow_node_runs(project_id, workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_node_started
  ON workflow_node_runs(project_id, node_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_key_started
  ON workflow_node_runs(project_id, node_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_node_runs_project_status_started
  ON workflow_node_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
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

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project_received
  ON webhook_deliveries(project_id, received_at DESC);

CREATE TABLE IF NOT EXISTS webhook_runs (
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
  error TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_started
  ON webhook_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_connector_started
  ON webhook_runs(project_id, connector_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_webhook_started
  ON webhook_runs(project_id, connector_id, webhook_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_status_started
  ON webhook_runs(project_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_runs_project_idempotency
  ON webhook_runs(project_id, idempotency_key);

CREATE TABLE IF NOT EXISTS rule_states (
  project_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('object')),
  object_type_id TEXT NOT NULL,
  primary_id TEXT NOT NULL,
  triggered_at TEXT NOT NULL,
  PRIMARY KEY (project_id, rule_id, subject_kind, object_type_id, primary_id)
);

CREATE INDEX IF NOT EXISTS idx_rule_states_project_rule
  ON rule_states(project_id, rule_id);

-- Object and timeseries projections can both apply the same telemetry event.
CREATE TABLE IF NOT EXISTS applied_events_objects (
  event_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS applied_events_timeseries (
  event_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS action_runs (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('none', 'object')),
  object_type_id TEXT,
  primary_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  params TEXT NOT NULL,
  error_name TEXT,
  error_message TEXT,
  error_phase TEXT CHECK (error_phase IS NULL OR error_phase IN ('handler', 'cancelled')),
  metadata TEXT,
  CHECK (
    (subject_kind = 'none' AND object_type_id IS NULL AND primary_id IS NULL)
    OR (subject_kind = 'object' AND object_type_id IS NOT NULL AND primary_id IS NOT NULL)
  ),
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_action_runs_project_started
  ON action_runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_action_started
  ON action_runs(project_id, action_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_object_started
  ON action_runs(project_id, object_type_id, primary_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_runs_project_status_started
  ON action_runs(project_id, status, started_at DESC);

CREATE TABLE IF NOT EXISTS auth_users (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_project_email
  ON auth_users(project_id, email);
CREATE INDEX IF NOT EXISTS idx_auth_users_project_status_created
  ON auth_users(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_users_project_created
  ON auth_users(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_user_identities (
  project_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  claims TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, strategy_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_user_identities_user
  ON auth_user_identities(project_id, user_id);

CREATE TABLE IF NOT EXISTS auth_sessions (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'atlas',
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions(project_id, user_id, audience, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token
  ON auth_sessions(project_id, id, token_hash);

CREATE TABLE IF NOT EXISTS auth_invitations (
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

CREATE INDEX IF NOT EXISTS idx_auth_invitations_project_email
  ON auth_invitations(project_id, email, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_auth_invitations_project_status_created
  ON auth_invitations(project_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_invitation_groups (
  project_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (project_id, invitation_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_invitation_groups_group
  ON auth_invitation_groups(project_id, group_id);
CREATE INDEX IF NOT EXISTS idx_auth_invitation_groups_invitation_position
  ON auth_invitation_groups(project_id, invitation_id, position);

CREATE TABLE IF NOT EXISTS auth_group_memberships (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_group_memberships_group
  ON auth_group_memberships(project_id, group_id);

CREATE TABLE IF NOT EXISTS auth_magic_links (
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

CREATE INDEX IF NOT EXISTS idx_auth_magic_links_email_active
  ON auth_magic_links(project_id, email, consumed_at, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS auth_oidc_authorization_attempts (
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

CREATE INDEX IF NOT EXISTS idx_auth_oidc_attempts_active
  ON auth_oidc_authorization_attempts(project_id, strategy_id, consumed_at, expires_at);
