-- A membership the identity provider owns is recorded with source 'directory' and synced to the
-- provider's groups on every sign-in. Service accounts never sign in, so their table is unchanged.
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE auth_group_memberships_next (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('invitation', 'manual', 'agent', 'directory')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id, group_id)
);

INSERT INTO auth_group_memberships_next (project_id, user_id, group_id, source, created_at)
SELECT project_id, user_id, group_id, source, created_at
FROM auth_group_memberships;

DROP TABLE auth_group_memberships;
ALTER TABLE auth_group_memberships_next RENAME TO auth_group_memberships;

CREATE INDEX idx_auth_group_memberships_group
  ON auth_group_memberships(project_id, group_id);
