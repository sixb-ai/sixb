-- Durable staged-upload sessions, so an upload survives restarts and spans API replicas.
-- Timestamps are ISO-8601 UTC text and compare lexicographically.
CREATE TABLE file_upload_sessions (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  principal_key TEXT NOT NULL CHECK (length(principal_key) > 0),
  strategy TEXT NOT NULL CHECK (strategy IN ('server', 'direct-put', 'multipart')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'aborted')),
  file_name TEXT,
  media_type TEXT,
  logical_path TEXT,
  expected_size_bytes INTEGER CHECK (expected_size_bytes IS NULL OR expected_size_bytes >= 0),
  expected_digest TEXT,
  provider_upload TEXT CHECK (provider_upload IS NULL OR json_type(provider_upload) = 'object'),
  signed_parts TEXT NOT NULL CHECK (json_type(signed_parts) = 'array'),
  file_ref TEXT CHECK (file_ref IS NULL OR json_type(file_ref) = 'object'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  aborted_at TEXT,
  -- Derived by core (fileUploadSessionReapAt); NULL while an abandoned upload awaits its abort.
  reap_at TEXT,
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'aborted') = (aborted_at IS NOT NULL))
);

CREATE INDEX idx_file_upload_sessions_reap
  ON file_upload_sessions (reap_at)
  WHERE reap_at IS NOT NULL;

CREATE INDEX idx_file_upload_sessions_abandoned
  ON file_upload_sessions (project_id, expires_at)
  WHERE status = 'pending' AND provider_upload IS NOT NULL;
