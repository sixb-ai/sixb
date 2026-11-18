-- Where each person's reading of a conversation has reached: the seq of the last message they saw.
-- Nothing writes here when a message arrives: new ones sit past it until the reader moves it. A
-- retry or an edit that deletes messages pulls every place inside them back to just before them,
-- because the numbers they held go to what replaces them.
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
-- new. Only a person reads, so an owner that is system code or a service account gets no row; it
-- would break the CHECK above. From here on, a participant gets a row when they join, and an
-- owner when they first mark the thread read: until then, they read as 0.
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
  COALESCE(
    (
      SELECT MAX(seq) FROM agent_messages
      WHERE agent_messages.project_id = agent_threads.project_id
        AND agent_messages.thread_id = agent_threads.id
    ),
    0
  ),
  now()
FROM agent_threads
WHERE kind = 'conversation'
  AND owner_principal_type = 'user'
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
  COALESCE(
    (
      SELECT MAX(seq) FROM agent_messages
      WHERE agent_messages.project_id = thread.project_id
        AND agent_messages.thread_id = thread.id
    ),
    0
  ),
  now()
FROM agent_thread_participants AS participant
JOIN agent_threads AS thread
  ON thread.project_id = participant.project_id
  AND thread.id = participant.thread_id
ON CONFLICT DO NOTHING;
