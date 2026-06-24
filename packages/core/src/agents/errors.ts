/**
 * Base error for the agents module. Specific subclasses extend this so callers
 * can catch any agent-scoped failure with a single `instanceof AgentDefinitionError` check.
 */
export class AgentDefinitionError extends Error {
  readonly name: string = "AgentDefinitionError"
}

/**
 * Raised by the message adapters. `fromAiSdk` is **total**: rather than silently dropping a part it
 * cannot model, it throws this — which both prevents data loss and pinpoints exactly when the
 * {@link SixbMessage} part union must be extended. It also fires on transient/streaming parts that
 * must never be persisted, and on out-of-contract (non-JSON) payloads.
 */
export class AgentMessageAdapterError extends Error {
  readonly name = "AgentMessageAdapterError"
}
