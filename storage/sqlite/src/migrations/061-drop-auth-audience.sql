-- A project has one browser app, so sessions, magic links and sign-in attempts no longer name the
-- one they belong to. Atlas's browser sessions end here: their cookie is no longer read. Native
-- sessions carried Atlas's name only because the column needed a value, so they stay.
UPDATE auth_sessions
SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE audience = 'atlas'
  AND refresh_token_hash IS NULL
  AND revoked_at IS NULL;

DROP INDEX idx_auth_sessions_user_active;
ALTER TABLE auth_sessions DROP COLUMN audience;
CREATE INDEX idx_auth_sessions_user_active
  ON auth_sessions(project_id, user_id, revoked_at, expires_at);

ALTER TABLE auth_magic_links DROP COLUMN audience;
ALTER TABLE auth_oidc_authorization_attempts DROP COLUMN audience;
