-- A membership the identity provider owns is recorded with source 'directory' and synced to the
-- provider's groups on every sign-in. Service accounts never sign in, so their table is unchanged.
ALTER TABLE auth_group_memberships DROP CONSTRAINT auth_group_memberships_source_check;
ALTER TABLE auth_group_memberships ADD CONSTRAINT auth_group_memberships_source_check
  CHECK (source IN ('invitation', 'manual', 'agent', 'directory'));
