-- A visit's timeline reads what its session started: the roots it authorized in a window, then
-- everything they caused. A signed-in session is the credential of its roots, a shared link's
-- session their delegation; a child names its parent. Agent executions copy their parent's
-- session: the root indexes hold only executions without a parent, so they never see those, and
-- end with `id` so the root read's order needs no sort.
CREATE INDEX idx_executions_session_roots
  ON executions (project_id, authority_session_id, created_at, id)
  WHERE authority_session_id IS NOT NULL AND parent_execution_id IS NULL;
CREATE INDEX idx_executions_delegation_roots
  ON executions (project_id, authority_delegation_session_id, created_at, id)
  WHERE authority_delegation_session_id IS NOT NULL AND parent_execution_id IS NULL;
CREATE INDEX idx_executions_parent
  ON executions (project_id, parent_execution_id)
  WHERE parent_execution_id IS NOT NULL;

-- A user's connection history lists all their sessions, revoked and expired ones too, newest
-- first.
CREATE INDEX idx_auth_sessions_user_created
  ON auth_sessions (project_id, user_id, created_at, id);
