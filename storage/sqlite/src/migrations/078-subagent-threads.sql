-- A sub-agent works in a thread of its own: its task and its work are that thread's messages, and
-- each of its runs has the thread and a trigger message, as a turn does. The thread's parent is the
-- conversation, which every read of it goes through, and its spawning turn and key name it.
--
-- SQLite adds neither a foreign key nor a check with ALTER TABLE: both tables are rebuilt, as 033
-- rebuilt `agent_runs`. Their references use the final names.

-- The children admitted before this have no thread. Each gets one named as a new child's is, with
-- its task as the only message: what it answered stays in its parent's `wait_agent` output.
CREATE TEMP TABLE legacy_subagent_threads AS
SELECT
  child.project_id,
  child.id AS run_id,
  'agt_thr_child_' || CASE
    WHEN substr(child.id, 1, 14) = 'agt_run_child_' THEN substr(child.id, 15)
    ELSE child.id
  END AS thread_id,
  'agt_msg_child_' || CASE
    WHEN substr(child.id, 1, 14) = 'agt_run_child_' THEN substr(child.id, 15)
    ELSE child.id
  END AS message_id
FROM agent_runs AS child
WHERE child.kind = 'subagent' AND child.thread_id IS NULL;

CREATE TABLE agent_threads_v2 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'conversation' CHECK (kind IN ('conversation', 'subagent')),
  parent_thread_id TEXT,
  parent_run_id TEXT,
  spawn_key TEXT,
  owner_principal_type TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  active_run_id TEXT,
  last_message_at TEXT,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sandbox_params TEXT CHECK (
    sandbox_params IS NULL
    OR (json_valid(sandbox_params) AND json_type(sandbox_params) = 'object')
  ),
  sandbox_state TEXT CHECK (
    sandbox_state IS NULL
    OR (json_valid(sandbox_state) AND json_type(sandbox_state) = 'object')
  ),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, parent_run_id, spawn_key),
  -- A conversation's sub-agent threads go with it.
  FOREIGN KEY (project_id, parent_thread_id)
    REFERENCES agent_threads (project_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (project_id, parent_run_id)
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  CHECK (
    (
      kind = 'conversation'
      AND parent_thread_id IS NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND parent_thread_id IS NOT NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND sandbox_params IS NULL
    )
  )
);

INSERT INTO agent_threads_v2 (
  project_id, id, owner_principal_type, owner_principal_id, title, status, active_run_id,
  last_message_at, message_count, created_at, updated_at, sandbox_params, sandbox_state
)
SELECT
  project_id, id, owner_principal_type, owner_principal_id, title, status, active_run_id,
  last_message_at, message_count, created_at, updated_at, sandbox_params, sandbox_state
FROM agent_threads;

INSERT INTO agent_threads_v2 (
  project_id, id, kind, parent_thread_id, parent_run_id, spawn_key, owner_principal_type,
  owner_principal_id, status, active_run_id, last_message_at, message_count, created_at,
  updated_at
)
SELECT
  child.project_id,
  legacy.thread_id,
  'subagent',
  parent.thread_id,
  child.parent_run_id,
  child.spawn_key,
  conversation.owner_principal_type,
  conversation.owner_principal_id,
  'active',
  CASE WHEN child.status IN ('queued', 'running') THEN child.id END,
  child.created_at,
  1,
  child.created_at,
  COALESCE(child.completed_at, child.created_at)
FROM legacy_subagent_threads AS legacy
JOIN agent_runs AS child ON child.project_id = legacy.project_id AND child.id = legacy.run_id
JOIN agent_runs AS parent
  ON parent.project_id = child.project_id AND parent.id = child.parent_run_id
JOIN agent_threads AS conversation
  ON conversation.project_id = parent.project_id AND conversation.id = parent.thread_id;

DROP TABLE agent_threads;
ALTER TABLE agent_threads_v2 RENAME TO agent_threads;

-- Lists read conversations only, so a conversation's children never weigh on them.
CREATE INDEX idx_agent_threads_project_activity
  ON agent_threads(project_id, COALESCE(last_message_at, created_at) DESC)
  WHERE kind = 'conversation';
CREATE INDEX idx_agent_threads_project_status_activity
  ON agent_threads(project_id, status, COALESCE(last_message_at, created_at) DESC)
  WHERE kind = 'conversation';
CREATE INDEX idx_agent_threads_project_owner_activity
  ON agent_threads(
    project_id,
    owner_principal_type,
    owner_principal_id,
    COALESCE(last_message_at, created_at) DESC
  )
  WHERE kind = 'conversation';

-- A conversation's children, in the order they were spawned. Only a child has a parent, so the
-- index holds children only, and a read by `parent_thread_id` can use it.
CREATE INDEX idx_agent_threads_children
  ON agent_threads(project_id, parent_thread_id, created_at, id)
  WHERE parent_thread_id IS NOT NULL;

INSERT INTO agent_messages (
  project_id, id, thread_id, run_id, role, seq, parts, content_version, created_at
)
SELECT
  child.project_id,
  legacy.message_id,
  legacy.thread_id,
  child.id,
  'user',
  1,
  json_array(json_object('type', 'text', 'text', json_extract(child.spec, '$.task'))),
  2,
  child.created_at
FROM legacy_subagent_threads AS legacy
JOIN agent_runs AS child ON child.project_id = legacy.project_id AND child.id = legacy.run_id;

CREATE TABLE agent_runs_v6 (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'conversation' CHECK (kind IN ('conversation', 'subagent')),
  thread_id TEXT,
  trigger_message_id TEXT,
  parent_run_id TEXT,
  spawn_key TEXT,
  spec TEXT CHECK (spec IS NULL OR json_valid(spec)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  model_id TEXT,
  finish_reason TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  diagnostics TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  execution_token TEXT,
  execution_queue_lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, execution_id),
  UNIQUE (project_id, parent_run_id, spawn_key),
  FOREIGN KEY (project_id, execution_id)
    REFERENCES executions (project_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_run_id)
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  CHECK ((execution_token IS NULL) = (execution_queue_lease_expires_at IS NULL)),
  CHECK (
    (
      kind = 'conversation'
      AND thread_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NULL
      AND spawn_key IS NULL
      AND result IS NULL
    )
    OR
    (
      kind = 'subagent'
      AND thread_id IS NOT NULL
      AND trigger_message_id IS NOT NULL
      AND parent_run_id IS NOT NULL
      AND spawn_key IS NOT NULL
      AND spec IS NOT NULL
    )
  ),
  CHECK (kind <> 'subagent' OR status <> 'succeeded' OR result IS NOT NULL)
);

INSERT INTO agent_runs_v6 (
  project_id, id, execution_id, kind, thread_id, trigger_message_id, parent_run_id, spawn_key,
  spec, result, status, model_id, finish_reason, error, diagnostics, attempt, execution_token,
  execution_queue_lease_expires_at, created_at, started_at, completed_at
)
SELECT
  run.project_id, run.id, run.execution_id, run.kind,
  COALESCE(run.thread_id, legacy.thread_id),
  COALESCE(run.trigger_message_id, legacy.message_id),
  run.parent_run_id, run.spawn_key, run.spec, run.result, run.status, run.model_id,
  run.finish_reason, run.error, run.diagnostics, run.attempt, run.execution_token,
  run.execution_queue_lease_expires_at, run.created_at, run.started_at, run.completed_at
FROM agent_runs AS run
LEFT JOIN legacy_subagent_threads AS legacy
  ON legacy.project_id = run.project_id AND legacy.run_id = run.id;

DROP TABLE agent_runs;
ALTER TABLE agent_runs_v6 RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_project_thread_started
  ON agent_runs (project_id, thread_id, COALESCE(started_at, created_at) DESC, id DESC);
CREATE INDEX idx_agent_runs_project_status_created
  ON agent_runs (project_id, status, created_at, id);
CREATE INDEX idx_agent_runs_project_parent_started
  ON agent_runs (
    project_id,
    parent_run_id,
    status,
    COALESCE(started_at, created_at) DESC,
    id DESC
  );

DROP TABLE legacy_subagent_threads;
