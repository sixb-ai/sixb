-- The artifacts a user message carries as context, as `agentContext.artifact()` sends them, so the
-- conversations about an artifact are found without reading every message. Only the messages that
-- carry one are indexed, by the artifacts' ids alone: a lookup reads the few that name it.
CREATE INDEX idx_agent_messages_artifact_context
  ON agent_messages USING gin (
    (jsonb_path_query_array(
      parts,
      '$[*] ? (@.type == "context" && @.context.kind == "artifact").context.id'
    )) jsonb_path_ops
  )
  WHERE role = 'user' AND parts @> '[{"type":"context","context":{"kind":"artifact"}}]';
