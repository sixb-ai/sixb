-- Calls of the Agent that wait for whoever asked for the turn. A call's run id is its key: a
-- thread holds at most one pending, approved or denied approval per key, and a cancelled,
-- superseded or expired one lets the same call ask again. Timestamps are ISO-8601 UTC text and
-- compare lexicographically.
CREATE TABLE agent_approvals (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  thread_id TEXT NOT NULL,
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  caller_run_id TEXT NOT NULL CHECK (length(caller_run_id) > 0),
  requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'serviceAccount', 'system')),
  requested_by_id TEXT NOT NULL CHECK (length(requested_by_id) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'accept-edits')),
  call_key TEXT NOT NULL CHECK (length(call_key) > 0),
  call TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'superseded', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_type TEXT CHECK (decided_by_type IN ('user', 'serviceAccount', 'system')),
  decided_by_id TEXT,
  outcome TEXT,
  reported_in_message_id TEXT,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_agent_approvals_live_call
  ON agent_approvals (project_id, thread_id, call_key)
  WHERE status IN ('pending', 'approved', 'denied');

CREATE INDEX idx_agent_approvals_thread ON agent_approvals (project_id, thread_id, created_at);
CREATE INDEX idx_agent_approvals_run ON agent_approvals (project_id, run_id, status);
CREATE INDEX idx_agent_approvals_caller_run ON agent_approvals (project_id, caller_run_id, status);
CREATE INDEX idx_agent_approvals_requester
  ON agent_approvals (project_id, requested_by_type, requested_by_id, status);

-- What each user lets the Agent change without asking: a default, then their own choice in a
-- thread. Absent rows fall back, in that order.
CREATE TABLE agent_user_settings (
  project_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'serviceAccount', 'system')),
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('manual', 'accept-edits', 'auto')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, principal_type, principal_id)
);

CREATE TABLE agent_thread_user_settings (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'serviceAccount', 'system')),
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('manual', 'accept-edits', 'auto')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, thread_id, principal_type, principal_id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);
