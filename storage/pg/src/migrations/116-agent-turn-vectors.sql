-- Each conversation turn's embedding, so the Agent can find earlier conversations by meaning.
-- Persistence needs no extension: vectors are REAL[], cast to pgvector only when searched.

-- `message_revision` moves with every message added to a thread or taken from it: indexing writes
-- only while the revision it read the thread at still holds. `indexed_revision` is the revision its
-- turns were last indexed whole at, NULL before or while part way: a thread where the two differ is
-- behind. `turns_behind` stores that comparison so the planner knows how few threads it holds, and
-- the partial index below lists only those.
ALTER TABLE agent_threads ADD COLUMN message_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agent_threads ADD COLUMN indexed_revision BIGINT;
ALTER TABLE agent_threads ADD COLUMN turns_behind BOOLEAN NOT NULL
  GENERATED ALWAYS AS (indexed_revision IS DISTINCT FROM message_revision) STORED;

CREATE INDEX idx_agent_threads_turns_behind
  ON agent_threads (project_id, (COALESCE(last_message_at, created_at)) DESC, id)
  WHERE kind = 'conversation' AND turns_behind;

-- One row per chunk of a turn, keyed by the message that opens it: a retry or an edit reuses seq
-- numbers, never ids. Deleting that message deletes the turn's vectors.
CREATE TABLE agent_turn_vectors (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chunk INTEGER NOT NULL CHECK (chunk >= 0),
  first_seq INTEGER NOT NULL CHECK (first_seq >= 1),
  last_seq INTEGER NOT NULL CHECK (last_seq >= first_seq),
  turn_at TIMESTAMPTZ NOT NULL,
  text TEXT NOT NULL CHECK (length(btrim(text)) > 0),
  configuration TEXT NOT NULL CHECK (length(configuration) > 0),
  embedding REAL[] NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, message_id, chunk),
  FOREIGN KEY (project_id, message_id) REFERENCES agent_messages (project_id, id) ON DELETE CASCADE,
  CONSTRAINT agent_turn_vectors_values CHECK (
    cardinality(embedding) BETWEEN 1 AND 16000
    AND array_ndims(embedding) = 1 AND array_lower(embedding, 1) = 1
    AND array_position(embedding, NULL) IS NULL
    AND '-Infinity'::real < ALL(embedding) AND 'Infinity'::real > ALL(embedding)
    AND 0::real <> ANY(embedding)
  )
);

CREATE INDEX idx_agent_turn_vectors_thread
  ON agent_turn_vectors (project_id, thread_id, first_seq);
-- Search reads one configuration's vectors, narrowed by when the turn happened.
CREATE INDEX idx_agent_turn_vectors_search
  ON agent_turn_vectors (project_id, configuration, turn_at);

-- How a conversation is indexed: for which configuration, from where a deletion sends indexing
-- back (`stale_from_seq`), until when it waits for an AI limit's reset or a failure's backoff, and
-- the revision a failure no retry fixes stopped it at (`halted_revision`).
CREATE TABLE agent_thread_index_state (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  configuration TEXT NOT NULL CHECK (length(configuration) > 0),
  stale_from_seq INTEGER CHECK (stale_from_seq >= 1),
  deferred_until TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  halted_revision BIGINT CHECK (halted_revision >= 0),
  indexed_at TIMESTAMPTZ,
  PRIMARY KEY (project_id, thread_id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

-- After the model changes, every thread indexed with the one before is behind.
CREATE INDEX idx_agent_thread_index_state_configuration
  ON agent_thread_index_state (project_id, configuration);

-- Indexing runs as the kernel operation `agents.indexTurns`, on the project's model budget. The
-- check is `NOT VALID`: a widened list cannot break a row that exists, and validating would scan
-- `executions` under this lock.
ALTER TABLE executions DROP CONSTRAINT executions_authority_kernel_operation_check;
ALTER TABLE executions ADD CONSTRAINT executions_authority_kernel_operation_check
  CHECK (
    authority_kernel_operation IS NULL
      OR authority_kernel_operation IN (
        'ontology.recover', 'ontology.indexVectors', 'artifacts.transcribeMedia', 'agents.indexTurns'
      )
  ) NOT VALID;
