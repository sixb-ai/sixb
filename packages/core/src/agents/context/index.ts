/** Context authoring and comparison for application clients. */
export type {
  AgentContextEntryInput,
  AgentContextInput,
  AgentContextOrigin,
  AgentContextPart,
} from "./entries"
export {
  agentContext,
  agentContextFingerprint,
  agentContextIdentity,
  MAX_AGENT_APP_STATE_ENTRY_BYTES,
  MAX_AGENT_APP_STATE_TOTAL_BYTES,
  MAX_AGENT_CONTEXT_ENTRIES,
} from "./entries"
