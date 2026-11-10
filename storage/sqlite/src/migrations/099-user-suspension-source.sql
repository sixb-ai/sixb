-- Who suspended a user: an administrator or server code ('manual'), or the identity provider's
-- directory ('directory'), which may lift only its own suspensions. Only a suspended user has one,
-- and every suspension made before this column existed was manual.
ALTER TABLE auth_users
  ADD COLUMN suspension_source TEXT CHECK (suspension_source IN ('manual', 'directory'));

UPDATE auth_users SET suspension_source = 'manual' WHERE status = 'suspended';
