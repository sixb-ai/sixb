-- The users a thread's owner added to the conversation. Only users take part: only a signed-in
-- user talks to the Agent. Listing the threads shared with someone reads the principal index.
CREATE TABLE agent_thread_participants (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type = 'user'),
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  added_at TEXT NOT NULL,
  added_by_type TEXT NOT NULL CHECK (added_by_type IN ('user', 'serviceAccount', 'system')),
  added_by_id TEXT NOT NULL CHECK (length(added_by_id) > 0),
  PRIMARY KEY (project_id, thread_id, principal_type, principal_id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_thread_participants_principal
  ON agent_thread_participants (project_id, principal_type, principal_id, thread_id);
