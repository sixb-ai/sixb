-- A connection belongs to the project or to one person. The project's owner_id is empty, so the
-- unique key over (owner_type, owner_id, slot) never meets a NULL. Existing rows become the
-- project's; the defaults are dropped afterwards so every write has to name its owner.
ALTER TABLE connector_connections
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

ALTER TABLE connector_connections
  ALTER COLUMN owner_type DROP DEFAULT,
  ALTER COLUMN owner_id DROP DEFAULT,
  ADD CONSTRAINT connector_connections_owner_check CHECK (
    (owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')
  ),
  DROP CONSTRAINT connector_connections_project_id_connector_id_slot_key,
  ADD CONSTRAINT connector_connections_owner_slot_key
    UNIQUE (project_id, connector_id, owner_type, owner_id, slot);

ALTER TABLE connector_connection_runs
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

ALTER TABLE connector_connection_runs
  ALTER COLUMN owner_type DROP DEFAULT,
  ALTER COLUMN owner_id DROP DEFAULT,
  ADD CONSTRAINT connector_connection_runs_owner_check CHECK (
    (owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')
  );

ALTER TABLE connector_authorization_attempts
  ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'project',
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

ALTER TABLE connector_authorization_attempts
  ALTER COLUMN owner_type DROP DEFAULT,
  ALTER COLUMN owner_id DROP DEFAULT,
  ADD CONSTRAINT connector_authorization_attempts_owner_check CHECK (
    (owner_type = 'project' AND owner_id = '') OR (owner_type = 'user' AND owner_id <> '')
  );
