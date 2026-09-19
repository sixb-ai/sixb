-- Durable staged-upload sessions, so an upload survives restarts and spans API replicas.
CREATE TABLE file_upload_sessions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  principal_key TEXT NOT NULL CHECK (length(principal_key) > 0),
  strategy TEXT NOT NULL CHECK (strategy IN ('server', 'direct-put', 'multipart')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'aborted')),
  file_name TEXT,
  media_type TEXT,
  logical_path TEXT,
  expected_size_bytes BIGINT CHECK (expected_size_bytes IS NULL OR expected_size_bytes >= 0),
  expected_digest TEXT,
  provider_upload JSONB CHECK (provider_upload IS NULL OR jsonb_typeof(provider_upload) = 'object'),
  signed_parts JSONB NOT NULL CHECK (jsonb_typeof(signed_parts) = 'array'),
  file_ref JSONB CHECK (file_ref IS NULL OR jsonb_typeof(file_ref) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  aborted_at TIMESTAMPTZ,
  -- Derived by core (fileUploadSessionReapAt); NULL while an abandoned upload awaits its abort.
  reap_at TIMESTAMPTZ,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'aborted') = (aborted_at IS NOT NULL))
);

CREATE INDEX idx_file_upload_sessions_reap
  ON file_upload_sessions (reap_at)
  WHERE reap_at IS NOT NULL;

CREATE INDEX idx_file_upload_sessions_abandoned
  ON file_upload_sessions (expires_at)
  WHERE status = 'pending' AND provider_upload IS NOT NULL;
