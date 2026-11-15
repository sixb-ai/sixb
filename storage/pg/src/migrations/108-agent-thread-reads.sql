-- Where each person's reading of a conversation has reached: the seq of the last message they saw.
-- Nothing writes here when activity happens. A new message moves the thread's `last_message_seq`
-- past it, and only the reader advances it, so every device reads the same position.
--
-- `last_message_seq` is the thread's high-water mark. It never moves back: a retried turn deletes
-- its messages, and the retry's next message continues past the numbers those held, so a reused
-- number can never hide a new message from a reader.
ALTER TABLE agent_threads ADD COLUMN last_message_seq INTEGER NOT NULL DEFAULT 0;

UPDATE agent_threads
SET last_message_seq = COALESCE(
  (
    SELECT MAX(seq)
    FROM agent_messages
    WHERE agent_messages.project_id = agent_threads.project_id
      AND agent_messages.thread_id = agent_threads.id
  ),
  0
);

CREATE TABLE agent_thread_reads (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type = 'user'),
  principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
  through_seq INTEGER NOT NULL CHECK (through_seq >= 0),
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, thread_id, principal_type, principal_id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

-- Everyone starts caught up: the first deploy must not mark every thread that already existed as
-- new. A row is then created as a thread is created and as each participant joins it.
INSERT INTO agent_thread_reads (
  project_id,
  thread_id,
  principal_type,
  principal_id,
  through_seq,
  read_at
)
SELECT
  project_id,
  id,
  owner_principal_type,
  owner_principal_id,
  last_message_seq,
  now()
FROM agent_threads
WHERE kind = 'conversation'
ON CONFLICT DO NOTHING;

INSERT INTO agent_thread_reads (
  project_id,
  thread_id,
  principal_type,
  principal_id,
  through_seq,
  read_at
)
SELECT
  participant.project_id,
  participant.thread_id,
  participant.principal_type,
  participant.principal_id,
  thread.last_message_seq,
  now()
FROM agent_thread_participants AS participant
JOIN agent_threads AS thread
  ON thread.project_id = participant.project_id
  AND thread.id = participant.thread_id
ON CONFLICT DO NOTHING;
