-- Existing attempts retain their encrypted S256 verifier. NULL denotes disabled PKCE.
ALTER TABLE connector_authorization_attempts
  ALTER COLUMN code_verifier DROP NOT NULL;
