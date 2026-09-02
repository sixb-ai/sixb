CREATE TABLE auth_device_authorizations (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  device_code_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  client_name TEXT NOT NULL,
  token_name TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  approved_user_id TEXT,
  approved_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  denied_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, user_code),
  FOREIGN KEY (project_id, approved_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, approved_session_id) REFERENCES auth_sessions (project_id, id)
);

CREATE INDEX idx_auth_device_authorizations_pending
  ON auth_device_authorizations (project_id, status, expires_at DESC);
