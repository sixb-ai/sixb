-- Native clients, such as the CLI, hold their session as bearer tokens: a
-- short-lived access token, whose hash is `token_hash`, and a rotating refresh token. Browser
-- sessions leave these columns NULL; `refresh_token_hash IS NULL` is what marks a cookie session.
ALTER TABLE auth_sessions
  ADD COLUMN client_name TEXT,
  ADD COLUMN access_expires_at TIMESTAMPTZ,
  ADD COLUMN refresh_token_hash TEXT,
  ADD COLUMN previous_refresh_token_hash TEXT,
  ADD COLUMN refreshed_at TIMESTAMPTZ,
  ADD CONSTRAINT auth_sessions_bearer_state CHECK (
    (refresh_token_hash IS NULL) = (client_name IS NULL)
    AND (refresh_token_hash IS NULL) = (access_expires_at IS NULL)
    AND (refresh_token_hash IS NOT NULL OR previous_refresh_token_hash IS NULL)
  );

-- The device flow now starts a session instead of issuing a personal access token.
ALTER TABLE auth_device_authorizations
  DROP COLUMN token_name,
  DROP COLUMN token_expires_at;
