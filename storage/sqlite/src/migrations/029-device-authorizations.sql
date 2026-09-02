CREATE TABLE auth_device_authorizations (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  device_code_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  client_name TEXT NOT NULL,
  token_name TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  approved_user_id TEXT,
  approved_session_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  denied_at TEXT,
  consumed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, user_code)
);

CREATE INDEX idx_auth_device_authorizations_pending
  ON auth_device_authorizations(project_id, status, expires_at);
