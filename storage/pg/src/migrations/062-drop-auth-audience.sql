-- A project has one browser app, so sessions, magic links and sign-in attempts no longer name the
-- one they belong to. Atlas's browser sessions end here: their cookie is no longer read. Native
-- sessions carried Atlas's name only because the column needed a value, so they stay.
UPDATE auth_sessions
SET revoked_at = now()
WHERE audience = 'atlas'
  AND refresh_token_hash IS NULL
  AND revoked_at IS NULL;

-- Dropping the column drops the two indexes that name it.
ALTER TABLE auth_sessions DROP COLUMN audience;
CREATE INDEX idx_auth_sessions_user_active
  ON auth_sessions (project_id, user_id, expires_at DESC, created_at DESC, id DESC)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_auth_sessions_user_created
  ON auth_sessions (project_id, user_id, created_at DESC, id DESC);

ALTER TABLE auth_magic_links DROP COLUMN audience;
ALTER TABLE auth_oidc_authorization_attempts DROP COLUMN audience;
