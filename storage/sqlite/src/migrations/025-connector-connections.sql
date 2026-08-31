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
  callback_started_at TEXT,
  expires_at TEXT,
  authorization_id TEXT,
  cleanup_authorization_id TEXT,
  connections TEXT CHECK (
    connections IS NULL OR (json_valid(connections) AND json_type(connections) = 'array')
  ),
  error TEXT CHECK (error IS NULL OR (json_valid(error) AND json_type(error) = 'object')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
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
    OR
    (
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
    OR
    (
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
    OR
    (
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
    OR
    (
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
    OR
    (
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
  code_verifier TEXT NOT NULL CHECK (
    json_valid(code_verifier) AND json_type(code_verifier) = 'object'
  ),
  redirect_uri TEXT NOT NULL,
  connection_run_id TEXT,
  return_to TEXT,
  callback_binding_hash TEXT,
  reauthorization_id TEXT,
  reauthorization_revision INTEGER CHECK (
    reauthorization_revision IS NULL OR reauthorization_revision >= 0
  ),
  reauthorization_connection_ids TEXT CHECK (
    reauthorization_connection_ids IS NULL
    OR (json_valid(reauthorization_connection_ids) AND json_type(reauthorization_connection_ids) = 'array')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connector_id, connection_run_id),
  FOREIGN KEY (project_id, connector_id, connection_run_id)
    REFERENCES connector_connection_runs (project_id, connector_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (connection_run_id IS NULL AND return_to IS NULL AND callback_binding_hash IS NULL)
    OR
    (connection_run_id IS NOT NULL AND return_to IS NOT NULL AND callback_binding_hash IS NOT NULL)
  ),
  CHECK (
    (reauthorization_id IS NULL AND reauthorization_revision IS NULL AND reauthorization_connection_ids IS NULL)
    OR
    (reauthorization_id IS NOT NULL AND reauthorization_revision IS NOT NULL AND reauthorization_connection_ids IS NOT NULL)
  )
);

CREATE INDEX idx_connector_attempts_expiry
  ON connector_authorization_attempts (project_id, connector_id, expires_at);

CREATE TABLE connector_authorizations (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  authorized_by TEXT NOT NULL CHECK (
    json_valid(authorized_by) AND json_type(authorized_by) = 'object'
  ),
  credentials TEXT CHECK (
    credentials IS NULL OR (json_valid(credentials) AND json_type(credentials) = 'object')
  ),
  credential_expires_at TEXT,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  accounts TEXT NOT NULL CHECK (json_valid(accounts) AND json_type(accounts) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('pending_selection', 'active', 'needs_reauthorization', 'revocation_pending', 'revoked')),
  selection_expires_at TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  mutation_id TEXT,
  mutation_kind TEXT CHECK (mutation_kind IN ('refresh', 'reauthorization', 'revocation')),
  mutation_phase TEXT CHECK (mutation_phase IN ('prepared', 'executing', 'result_staged')),
  mutation_holder_id TEXT,
  mutation_expires_at TEXT,
  mutation_deadline_at TEXT,
  mutation_expected_connection_ids TEXT CHECK (
    mutation_expected_connection_ids IS NULL
    OR (json_valid(mutation_expected_connection_ids) AND json_type(mutation_expected_connection_ids) = 'array')
  ),
  staged_credentials TEXT CHECK (
    staged_credentials IS NULL
    OR (json_valid(staged_credentials) AND json_type(staged_credentials) = 'object')
  ),
  staged_credential_expires_at TEXT,
  staged_scopes TEXT CHECK (
    staged_scopes IS NULL OR (json_valid(staged_scopes) AND json_type(staged_scopes) = 'array')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  CHECK (
    (mutation_id IS NULL AND mutation_kind IS NULL AND mutation_phase IS NULL AND mutation_holder_id IS NULL AND mutation_expires_at IS NULL AND mutation_deadline_at IS NULL AND mutation_expected_connection_ids IS NULL AND staged_credentials IS NULL AND staged_credential_expires_at IS NULL AND staged_scopes IS NULL)
    OR
    (mutation_id IS NOT NULL AND mutation_kind IS NOT NULL AND mutation_phase IS NOT NULL AND mutation_holder_id IS NOT NULL AND mutation_expires_at IS NOT NULL AND mutation_deadline_at IS NOT NULL)
  ),
  CHECK (
    (
      mutation_phase IS NULL
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR
    (
      mutation_phase IN ('prepared', 'executing')
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR
    (
      mutation_phase = 'result_staged'
      AND mutation_kind = 'revocation'
      AND staged_credentials IS NULL
      AND staged_credential_expires_at IS NULL
      AND staged_scopes IS NULL
    )
    OR
    (
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
  account TEXT NOT NULL CHECK (json_valid(account) AND json_type(account) = 'object'),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  disconnected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connector_id, slot),
  FOREIGN KEY (project_id, connector_id, authorization_id)
    REFERENCES connector_authorizations (project_id, connector_id, id)
    ON DELETE RESTRICT,
  CHECK ((status = 'connected') = (disconnected_at IS NULL)),
  CHECK (json_extract(account, '$.id') IS NOT NULL AND json_extract(account, '$.id') = account_id)
);

CREATE INDEX idx_connector_connections_authorization
  ON connector_connections (project_id, connector_id, authorization_id, status, id);
CREATE INDEX idx_connector_connections_status
  ON connector_connections (project_id, connector_id, status, id);
