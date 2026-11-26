-- Each conversation turn's embedding, so the Agent can find earlier conversations by meaning.
-- Persistence needs no extension: vectors are little-endian float32 blobs, searched with
-- sqlite-vec when it loads.

-- `message_revision` moves with every message added to a thread or taken from it: indexing writes
-- only while the revision it read the thread at still holds. `indexed_revision` is the revision its
-- turns were last indexed whole at, NULL before or while part way: a thread where the two differ is
-- behind, and the partial index below lists only those.
ALTER TABLE agent_threads ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_threads ADD COLUMN indexed_revision INTEGER;

CREATE INDEX idx_agent_threads_turns_behind
  ON agent_threads (project_id, (COALESCE(last_message_at, created_at)) DESC, id)
  WHERE kind = 'conversation' AND indexed_revision IS NOT message_revision;

-- One row per chunk of a turn, keyed by the message that opens it: a retry or an edit reuses seq
-- numbers, never ids. Deleting that message deletes the turn's vectors.
CREATE TABLE agent_turn_vectors (
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chunk INTEGER NOT NULL CHECK (chunk >= 0),
  first_seq INTEGER NOT NULL CHECK (first_seq >= 1),
  last_seq INTEGER NOT NULL CHECK (last_seq >= first_seq),
  turn_at TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  configuration TEXT NOT NULL CHECK (length(configuration) > 0),
  embedding BLOB NOT NULL CHECK (
    typeof(embedding) = 'blob' AND length(embedding) BETWEEN 4 AND 64000
    AND length(embedding) % 4 = 0
  ),
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, message_id, chunk),
  FOREIGN KEY (project_id, message_id) REFERENCES agent_messages (project_id, id) ON DELETE CASCADE
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
  deferred_until TEXT,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  halted_revision INTEGER CHECK (halted_revision >= 0),
  indexed_at TEXT,
  PRIMARY KEY (project_id, thread_id),
  FOREIGN KEY (project_id, thread_id) REFERENCES agent_threads (project_id, id) ON DELETE CASCADE
);

-- After the model changes, every thread indexed with the one before is behind.
CREATE INDEX idx_agent_thread_index_state_configuration
  ON agent_thread_index_state (project_id, configuration);

-- Indexing runs as the kernel operation `agents.indexTurns`, on the project's model budget. SQLite
-- cannot change a CHECK in place, so the executions table is rebuilt with every row, then its
-- indexes.
CREATE TABLE executions_v2 (
  project_id TEXT NOT NULL CHECK (length(trim(project_id)) > 0),
  id TEXT NOT NULL CHECK (length(trim(id)) > 0),
  executor_kind TEXT NOT NULL CHECK (
    executor_kind IN (
      'request', 'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow',
      'agent', 'kernel', 'script'
    )
  ),
  executor_id TEXT NOT NULL CHECK (length(trim(executor_id)) > 0),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN (
      'http', 'webhook', 'schedule', 'event', 'datasetVersion', 'execution', 'ontologyCommit',
      'script'
    )
  ),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  requested_by_user_id TEXT,
  requested_by_service_account_id TEXT,
  correlation_id TEXT NOT NULL CHECK (length(trim(correlation_id)) > 0),
  parent_execution_id TEXT,
  authority_kind TEXT NOT NULL CHECK (
    authority_kind IN ('principal', 'trustedPrimitive', 'delegated', 'kernel', 'script', 'disabled')
  ),
  authority_user_id TEXT,
  authority_service_account_id TEXT,
  authority_session_id TEXT,
  authority_access_token_id TEXT,
  authority_primitive_kind TEXT CHECK (
    authority_primitive_kind IS NULL
      OR authority_primitive_kind IN (
        'action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow'
      )
  ),
  authority_primitive_id TEXT,
  authority_kernel_operation TEXT CHECK (
    authority_kernel_operation IS NULL
      OR authority_kernel_operation IN (
        'ontology.recover', 'ontology.indexVectors', 'artifacts.transcribeMedia',
        'agents.indexTurns'
      )
  ),
  authority_delegation_kind TEXT CHECK (
    authority_delegation_kind IS NULL OR authority_delegation_kind = 'share'
  ),
  authority_delegation_id TEXT,
  authority_delegation_session_id TEXT,
  requester_group_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_execution_id) REFERENCES executions (project_id, id),
  FOREIGN KEY (project_id, requested_by_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, requested_by_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_user_id) REFERENCES auth_users (project_id, id),
  FOREIGN KEY (project_id, authority_service_account_id)
    REFERENCES auth_service_accounts (project_id, id),
  FOREIGN KEY (project_id, authority_session_id) REFERENCES auth_sessions (project_id, id),
  FOREIGN KEY (project_id, authority_access_token_id)
    REFERENCES auth_access_tokens (project_id, id),
  FOREIGN KEY (
    project_id, authority_delegation_session_id, authority_delegation_id
  ) REFERENCES share_sessions (project_id, id, grant_id),
  CHECK ((requested_by_user_id IS NOT NULL) + (requested_by_service_account_id IS NOT NULL) <= 1),
  CHECK (
    (source_kind = 'execution' AND parent_execution_id = source_id)
      OR (source_kind <> 'execution' AND parent_execution_id IS NULL)
  ),
  CHECK (
    (
      authority_kind = 'principal'
      AND (authority_user_id IS NOT NULL) + (authority_service_account_id IS NOT NULL) = 1
      AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) <= 1
      AND (authority_session_id IS NULL OR authority_user_id IS NOT NULL)
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      authority_kind = 'trustedPrimitive'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NOT NULL
      AND authority_primitive_id IS NOT NULL
      AND length(trim(authority_primitive_id)) > 0
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      authority_kind = 'delegated'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NOT NULL
      AND authority_delegation_kind = 'share'
      AND authority_delegation_id IS NOT NULL
      AND length(trim(authority_delegation_id)) > 0
      AND authority_delegation_session_id IS NOT NULL
      AND length(trim(authority_delegation_session_id)) > 0
    )
    OR (
      authority_kind = 'kernel'
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NOT NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
    OR (
      -- A script's authority is its run id, which `executor_id` already holds.
      authority_kind IN ('script', 'disabled')
      AND authority_user_id IS NULL
      AND authority_service_account_id IS NULL
      AND authority_session_id IS NULL
      AND authority_access_token_id IS NULL
      AND authority_primitive_kind IS NULL
      AND authority_primitive_id IS NULL
      AND authority_kernel_operation IS NULL
      AND authority_delegation_kind IS NULL
      AND authority_delegation_id IS NULL
      AND authority_delegation_session_id IS NULL
    )
  ),
  CHECK (
    (
      executor_kind = 'request'
      AND source_kind = 'http'
      AND executor_id = source_id
      AND (
        (
          authority_kind = 'principal'
          AND requested_by_user_id IS authority_user_id
          AND requested_by_service_account_id IS authority_service_account_id
        )
        OR (
          authority_kind IN ('delegated', 'disabled')
          AND requested_by_user_id IS NULL
          AND requested_by_service_account_id IS NULL
        )
      )
    )
    OR (
      executor_kind IN ('action', 'pipeline', 'projection', 'rule', 'sync', 'webhook', 'workflow')
      AND source_kind <> 'script'
      AND authority_kind = 'trustedPrimitive'
      AND executor_kind = authority_primitive_kind
    )
    OR (
      executor_kind = 'agent'
      AND source_kind = 'execution'
      AND (
        (
          authority_kind = 'principal'
          AND authority_service_account_id IS NOT NULL
          AND authority_session_id IS NULL
          AND authority_access_token_id IS NULL
        )
        OR (
          authority_kind = 'principal'
          AND authority_user_id IS NOT NULL
          AND (authority_session_id IS NOT NULL) + (authority_access_token_id IS NOT NULL) = 1
        )
        OR authority_kind = 'disabled'
      )
    )
    OR (executor_kind = 'kernel' AND authority_kind = 'kernel' AND source_kind <> 'script')
    OR (
      executor_kind = 'script'
      AND source_kind = 'script'
      AND authority_kind = 'script'
      AND requested_by_user_id IS NULL
      AND requested_by_service_account_id IS NULL
    )
  )
);

INSERT INTO executions_v2 (project_id, id, executor_kind, executor_id, source_kind, source_id, requested_by_user_id, requested_by_service_account_id, correlation_id, parent_execution_id, authority_kind, authority_user_id, authority_service_account_id, authority_session_id, authority_access_token_id, authority_primitive_kind, authority_primitive_id, authority_kernel_operation, authority_delegation_kind, authority_delegation_id, authority_delegation_session_id, requester_group_ids, created_at) SELECT project_id, id, executor_kind, executor_id, source_kind, source_id, requested_by_user_id, requested_by_service_account_id, correlation_id, parent_execution_id, authority_kind, authority_user_id, authority_service_account_id, authority_session_id, authority_access_token_id, authority_primitive_kind, authority_primitive_id, authority_kernel_operation, authority_delegation_kind, authority_delegation_id, authority_delegation_session_id, requester_group_ids, created_at FROM executions;
DROP TABLE executions;
ALTER TABLE executions_v2 RENAME TO executions;

CREATE INDEX idx_executions_session_roots
  ON executions (project_id, authority_session_id, created_at, id)
  WHERE authority_session_id IS NOT NULL AND parent_execution_id IS NULL;
CREATE INDEX idx_executions_delegation_roots
  ON executions (project_id, authority_delegation_session_id, created_at, id)
  WHERE authority_delegation_session_id IS NOT NULL AND parent_execution_id IS NULL;
CREATE INDEX idx_executions_parent
  ON executions (project_id, parent_execution_id)
  WHERE parent_execution_id IS NOT NULL;
