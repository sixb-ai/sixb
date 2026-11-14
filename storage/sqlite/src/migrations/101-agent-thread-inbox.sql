-- Mid-run steers and queued follow-up messages held outside `agent_messages` until delivered.
CREATE TABLE agent_thread_inbox (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(trim(message_id)) > 0),
  seq INTEGER NOT NULL CHECK (seq > 0),
  author_principal_type TEXT NOT NULL
    CHECK (author_principal_type IN ('user', 'serviceAccount', 'system')),
  author_principal_id TEXT NOT NULL CHECK (length(author_principal_id) > 0),
  mode TEXT NOT NULL CHECK (mode IN ('steer', 'queue')),
  parts TEXT NOT NULL,
  spec TEXT,
  time_zone TEXT,
  locale TEXT,
  immediate INTEGER NOT NULL DEFAULT 0 CHECK (immediate IN (0, 1)),
  claimed_by_run_id TEXT,
  claimed_by_token TEXT,
  claimed_by_step INTEGER,
  claimed_after_answer INTEGER CHECK (claimed_after_answer IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, message_id),
  UNIQUE (project_id, thread_id, seq),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_thread_inbox_thread_seq
  ON agent_thread_inbox (project_id, thread_id, seq);

CREATE INDEX idx_agent_thread_inbox_claimed_run
  ON agent_thread_inbox (project_id, claimed_by_run_id)
  WHERE claimed_by_run_id IS NOT NULL;
