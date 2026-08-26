CREATE TABLE connector_connection_runs (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('connect', 'reauthorize')),
  slot TEXT NOT NULL,
  initiated_by_execution_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
  waiting_for TEXT CHECK (waiting_for IN ('provider_authorization', 'account_selection')),
  processing_id TEXT,
  callback_started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  authorization_id TEXT,
  cleanup_authorization_id TEXT,
  connections JSONB CHECK (connections IS NULL OR jsonb_typeof(connections) = 'array'),
  error JSONB CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  CHECK (
    (
      status = 'waiting'
      AND waiting_for = 'provider_authorization'
      AND processing_id IS NULL
      AND callback_started_at IS NULL
      AND expires_at IS NOT NULL
      AND authorization_id IS NULL
      AND cleanup_authorization_id IS NULL
      AND connections IS NULL
      AND error IS NULL
      AND finished_at IS NULL
    )
    OR (
      status = 'waiting'
      AND waiting_for = 'account_selection'
      AND processing_id IS NULL
      AND callback_started_at IS NULL
      AND expires_at IS NOT NULL
      AND authorization_id IS NOT NULL
      AND cleanup_authorization_id IS NULL
      AND connections IS NULL
      AND error IS NULL
      AND finished_at IS NULL
    )
    OR (
      status = 'running'
      AND waiting_for IS NULL
      AND processing_id IS NOT NULL
      AND callback_started_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND cleanup_authorization_id IS NULL
      AND connections IS NULL
      AND error IS NULL
      AND finished_at IS NULL
    )
    OR (
      status = 'succeeded'
      AND waiting_for IS NULL
      AND processing_id IS NULL
      AND callback_started_at IS NULL
      AND expires_at IS NULL
      AND authorization_id IS NOT NULL
      AND connections IS NOT NULL
      AND error IS NULL
      AND finished_at IS NOT NULL
    )
    OR (
      status = 'failed'
      AND waiting_for IS NULL
      AND processing_id IS NULL
      AND callback_started_at IS NULL
      AND expires_at IS NULL
      AND cleanup_authorization_id IS NULL
      AND connections IS NULL
      AND error IS NOT NULL
      AND finished_at IS NOT NULL
    )
    OR (
      status IN ('cancelled', 'expired')
      AND waiting_for IS NULL
      AND processing_id IS NULL
      AND callback_started_at IS NULL
      AND expires_at IS NULL
      AND cleanup_authorization_id IS NULL
      AND connections IS NULL
      AND error IS NULL
      AND finished_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_connector_runs_status
  ON connector_connection_runs (project_id, connector_id, status, updated_at);

CREATE TABLE connector_authorization_attempts (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  slot TEXT NOT NULL,
  initiated_by_execution_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_verifier JSONB NOT NULL CHECK (jsonb_typeof(code_verifier) = 'object'),
  redirect_uri TEXT NOT NULL,
  connection_run_id TEXT,
  return_to TEXT,
  callback_binding_hash TEXT,
  reauthorization_id TEXT,
  reauthorization_revision INTEGER CHECK (reauthorization_revision IS NULL OR reauthorization_revision >= 0),
  reauthorization_connection_ids JSONB CHECK (
    reauthorization_connection_ids IS NULL OR jsonb_typeof(reauthorization_connection_ids) = 'array'
  ),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connector_id, connection_run_id),
  FOREIGN KEY (project_id, connector_id, connection_run_id)
    REFERENCES connector_connection_runs (project_id, connector_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (connection_run_id IS NULL AND return_to IS NULL AND callback_binding_hash IS NULL)
    OR (connection_run_id IS NOT NULL AND return_to IS NOT NULL AND callback_binding_hash IS NOT NULL)
  ),
  CHECK (
    (reauthorization_id IS NULL AND reauthorization_revision IS NULL AND reauthorization_connection_ids IS NULL)
    OR (reauthorization_id IS NOT NULL AND reauthorization_revision IS NOT NULL AND reauthorization_connection_ids IS NOT NULL)
  )
);

CREATE INDEX idx_connector_attempts_expiry
  ON connector_authorization_attempts (project_id, connector_id, expires_at);

CREATE TABLE connector_authorizations (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  authorized_by JSONB NOT NULL CHECK (jsonb_typeof(authorized_by) = 'object'),
  credentials JSONB CHECK (credentials IS NULL OR jsonb_typeof(credentials) = 'object'),
  credential_expires_at TIMESTAMPTZ,
  scopes JSONB NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
  accounts JSONB NOT NULL CHECK (jsonb_typeof(accounts) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending_selection', 'active', 'needs_reauthorization', 'revocation_pending', 'revoked')),
  selection_expires_at TIMESTAMPTZ,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  mutation_id TEXT,
  mutation_kind TEXT CHECK (mutation_kind IN ('refresh', 'reauthorization', 'revocation')),
  mutation_phase TEXT CHECK (mutation_phase IN ('prepared', 'executing', 'result_staged')),
  mutation_holder_id TEXT,
  mutation_expires_at TIMESTAMPTZ,
  mutation_deadline_at TIMESTAMPTZ,
  mutation_expected_connection_ids JSONB CHECK (
    mutation_expected_connection_ids IS NULL OR jsonb_typeof(mutation_expected_connection_ids) = 'array'
  ),
  staged_credentials JSONB CHECK (
    staged_credentials IS NULL OR jsonb_typeof(staged_credentials) = 'object'
  ),
  staged_credential_expires_at TIMESTAMPTZ,
  staged_scopes JSONB CHECK (staged_scopes IS NULL OR jsonb_typeof(staged_scopes) = 'array'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  CHECK (
    (mutation_id IS NULL AND mutation_kind IS NULL AND mutation_phase IS NULL AND mutation_holder_id IS NULL AND mutation_expires_at IS NULL AND mutation_deadline_at IS NULL AND mutation_expected_connection_ids IS NULL AND staged_credentials IS NULL AND staged_credential_expires_at IS NULL AND staged_scopes IS NULL)
    OR (mutation_id IS NOT NULL AND mutation_kind IS NOT NULL AND mutation_phase IS NOT NULL AND mutation_holder_id IS NOT NULL AND mutation_expires_at IS NOT NULL AND mutation_deadline_at IS NOT NULL)
  ),
  CHECK (
    (
      mutation_phase IS NULL
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR (
      mutation_phase IN ('prepared', 'executing')
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR (
      mutation_phase = 'result_staged'
      AND mutation_kind = 'revocation'
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR (
      mutation_phase = 'result_staged'
      AND mutation_kind IN ('refresh', 'reauthorization')
      AND staged_credentials IS NOT NULL
      AND staged_scopes IS NOT NULL
    )
  ),
  CHECK ((status = 'pending_selection') = (selection_expires_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (credentials IS NULL))
);

CREATE INDEX idx_connector_authorizations_status
  ON connector_authorizations (project_id, connector_id, status, updated_at);
CREATE INDEX idx_connector_authorizations_mutation_expiry
  ON connector_authorizations (project_id, connector_id, mutation_expires_at)
  WHERE mutation_id IS NOT NULL;

CREATE TABLE connector_connections (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  account JSONB NOT NULL CHECK (jsonb_typeof(account) = 'object'),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connector_id, slot),
  FOREIGN KEY (project_id, connector_id, authorization_id)
    REFERENCES connector_authorizations (project_id, connector_id, id)
    ON DELETE RESTRICT,
  CHECK ((status = 'connected') = (disconnected_at IS NULL)),
  CHECK (account ? 'id' AND account ->> 'id' = account_id)
);

CREATE INDEX idx_connector_connections_authorization
  ON connector_connections (project_id, connector_id, authorization_id, status, id);
CREATE INDEX idx_connector_connections_status
  ON connector_connections (project_id, connector_id, status, id);
