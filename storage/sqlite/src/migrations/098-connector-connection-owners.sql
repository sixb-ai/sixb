-- A connection belongs to the project or to one person. SQLite cannot change a unique key in
-- place, so connector_connections is rebuilt. The project's owner_id is empty, so the unique key
-- over (owner_type, owner_id, slot) never meets a NULL. Existing rows become the project's.
CREATE TABLE connector_connections_with_owner (
  project_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  account TEXT NOT NULL CHECK (json_valid(account) AND json_type(account) = 'object'),
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'disconnected')),
  disconnected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, connector_id, id),
  UNIQUE (project_id, id),
  UNIQUE (project_id, connector_id, owner_type, owner_id, slot),
  FOREIGN KEY (project_id, connector_id, authorization_id)
    REFERENCES connector_authorizations (project_id, connector_id, id)
    ON DELETE RESTRICT,
  CHECK ((owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')),
  CHECK ((status = 'connected') = (disconnected_at IS NULL)),
  CHECK (json_extract(account, '$.id') IS NOT NULL AND json_extract(account, '$.id') = account_id)
);

INSERT INTO connector_connections_with_owner (
  project_id, connector_id, id, authorization_id, owner_type, owner_id, slot, account,
  account_id, status, disconnected_at, created_at, updated_at
)
SELECT
  project_id, connector_id, id, authorization_id, 'project', '', slot, account,
  account_id, status, disconnected_at, created_at, updated_at
FROM connector_connections;

DROP TABLE connector_connections;
ALTER TABLE connector_connections_with_owner RENAME TO connector_connections;

CREATE INDEX idx_connector_connections_authorization
  ON connector_connections (project_id, connector_id, authorization_id, status, id);
CREATE INDEX idx_connector_connections_status
  ON connector_connections (project_id, connector_id, status, id);

-- Runs and attempts record whose connection they will make. Existing rows are the project's.
ALTER TABLE connector_connection_runs
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'project';
ALTER TABLE connector_connection_runs
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '' CHECK (
    (owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')
  );

ALTER TABLE connector_authorization_attempts
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'project';
ALTER TABLE connector_authorization_attempts
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '' CHECK (
    (owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')
  );
