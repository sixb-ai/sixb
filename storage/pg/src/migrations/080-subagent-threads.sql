-- A sub-agent works in a thread of its own: its task and its work are that thread's messages, and
-- each of its runs has the thread and a trigger message, as a turn does. The thread's parent is the
-- conversation, which every read of it goes through, and its spawning turn and key name it.
ALTER TABLE agent_threads
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'conversation'
    CHECK (kind IN ('conversation', 'subagent')),
  ADD COLUMN parent_thread_id TEXT,
  ADD COLUMN parent_run_id TEXT,
  ADD COLUMN spawn_key TEXT,
  ADD CONSTRAINT agent_threads_kind_fields CHECK (
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
  ),
  -- A conversation's sub-agent threads go with it.
  ADD CONSTRAINT fk_agent_threads_parent
    FOREIGN KEY (project_id, parent_thread_id)
    REFERENCES agent_threads (project_id, id)
    ON DELETE CASCADE,
  ADD CONSTRAINT fk_agent_threads_parent_run
    FOREIGN KEY (project_id, parent_run_id)
    REFERENCES agent_runs (project_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT uq_agent_threads_spawn UNIQUE (project_id, parent_run_id, spawn_key);

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_kind_fields;

-- The children admitted before this have no thread. Each gets one named as a new child's is, with
-- its task as the only message: what it answered stays in its parent's `wait_agent` output.
CREATE TEMPORARY TABLE legacy_subagent_threads ON COMMIT DROP AS
SELECT
  child.project_id,
  child.id AS run_id,
  'agt_thr_child_' || regexp_replace(child.id, '^agt_run_child_', '') AS thread_id,
  'agt_msg_child_' || regexp_replace(child.id, '^agt_run_child_', '') AS message_id
FROM agent_runs AS child
WHERE child.kind = 'subagent' AND child.thread_id IS NULL;

INSERT INTO agent_threads (
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
  jsonb_build_array(jsonb_build_object('type', 'text', 'text', child.spec->>'task')),
  2,
  child.created_at
FROM legacy_subagent_threads AS legacy
JOIN agent_runs AS child ON child.project_id = legacy.project_id AND child.id = legacy.run_id;

UPDATE agent_runs AS child
SET thread_id = legacy.thread_id, trigger_message_id = legacy.message_id
FROM legacy_subagent_threads AS legacy
WHERE child.project_id = legacy.project_id AND child.id = legacy.run_id;

DROP TABLE legacy_subagent_threads;

ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_kind_fields CHECK (
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
);

-- Lists read conversations only, so a conversation's children never weigh on them.
DROP INDEX idx_agent_threads_project_activity;
DROP INDEX idx_agent_threads_project_status_activity;
DROP INDEX idx_agent_threads_project_owner_activity;

CREATE INDEX idx_agent_threads_project_activity
  ON agent_threads (project_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE kind = 'conversation';
CREATE INDEX idx_agent_threads_project_status_activity
  ON agent_threads (project_id, status, (COALESCE(last_message_at, created_at)) DESC, id DESC)
  WHERE kind = 'conversation';
CREATE INDEX idx_agent_threads_project_owner_activity
  ON agent_threads (
    project_id,
    owner_principal_type,
    owner_principal_id,
    (COALESCE(last_message_at, created_at)) DESC,
    id DESC
  )
  WHERE kind = 'conversation';

-- A conversation's children, in the order they were spawned. Only a child has a parent, so the
-- index holds children only, and a read by `parent_thread_id` can use it.
CREATE INDEX idx_agent_threads_children
  ON agent_threads (project_id, parent_thread_id, created_at, id)
  WHERE parent_thread_id IS NOT NULL;
