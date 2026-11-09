-- Who suspended a user: an administrator or server code ('manual'), or the identity provider's
-- directory ('directory'), which may lift only its own suspensions. Only a suspended user has one,
-- and every suspension made before this column existed was manual.
ALTER TABLE auth_users ADD COLUMN suspension_source TEXT;

UPDATE auth_users SET suspension_source = 'manual' WHERE status = 'suspended';

ALTER TABLE auth_users
  ADD CONSTRAINT auth_users_suspension_source_check CHECK (
    (status = 'suspended' AND suspension_source IN ('manual', 'directory'))
    OR (status = 'active' AND suspension_source IS NULL)
  );
