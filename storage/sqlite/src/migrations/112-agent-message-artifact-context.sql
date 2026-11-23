-- The user messages that may carry an artifact as context, as `agentContext.artifact()` sends it,
-- so the conversations about an artifact are found without reading every message. SQLite indexes
-- no JSON array's members: the condition keeps the messages whose parts name any artifact, and a
-- lookup reads only those.
CREATE INDEX idx_agent_messages_artifact_context
  ON agent_messages (project_id, thread_id)
  WHERE role = 'user' AND instr(parts, '"kind":"artifact"') > 0;
