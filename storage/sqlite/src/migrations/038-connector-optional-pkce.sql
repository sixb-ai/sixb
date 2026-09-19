-- Rebuild to remove NOT NULL while preserving existing attempts and their constraints.
CREATE TABLE connector_authorization_attempts_optional_pkce (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  slot TEXT NOT NULL,
  initiated_by_execution_id TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_verifier TEXT CHECK (
    code_verifier IS NULL
    OR (json_valid(code_verifier) AND json_type(code_verifier) = 'object')
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

INSERT INTO connector_authorization_attempts_optional_pkce
SELECT * FROM connector_authorization_attempts;

DROP TABLE connector_authorization_attempts;
ALTER TABLE connector_authorization_attempts_optional_pkce RENAME TO connector_authorization_attempts;

CREATE INDEX idx_connector_attempts_expiry
  ON connector_authorization_attempts (project_id, connector_id, expires_at);
