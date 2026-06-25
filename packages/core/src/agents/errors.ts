/**
 * Base error for the agents module. Specific subclasses extend this so callers
 * can catch any agent-scoped failure with a single `instanceof AgentDefinitionError` check.
 */
export class AgentDefinitionError extends Error {
  readonly name: string = "AgentDefinitionError"
}
