-- Native clients, such as the CLI, hold their session as bearer tokens: a
-- short-lived access token, whose hash is `token_hash`, and a rotating refresh token. Browser
-- sessions leave these columns NULL; `refresh_token_hash IS NULL` is what marks a cookie session.
ALTER TABLE auth_sessions ADD COLUMN client_name TEXT;
ALTER TABLE auth_sessions ADD COLUMN access_expires_at TEXT;
ALTER TABLE auth_sessions ADD COLUMN refresh_token_hash TEXT;
ALTER TABLE auth_sessions ADD COLUMN previous_refresh_token_hash TEXT;
ALTER TABLE auth_sessions ADD COLUMN refreshed_at TEXT;

-- The device flow now starts a session instead of issuing a personal access token.
ALTER TABLE auth_device_authorizations DROP COLUMN token_name;
ALTER TABLE auth_device_authorizations DROP COLUMN token_expires_at;
