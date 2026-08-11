import type { AgentDefinition } from "./types"

/**
 * Holds the agent definitions registered with a SixbHost.
 *
 * Workers use the catalog to resolve a run's non-serialisable model. Protected thread and run
 * operations live on the execution-bound `Sixb.agents` facade.
 */
export class AgentsRuntime {
  private readonly agentsById: ReadonlyMap<string, AgentDefinition>

  constructor(agents: readonly AgentDefinition[]) {
    this.agentsById = new Map(agents.map((agent) => [agent.id, agent]))
  }

  /** All registered agent definitions. */
  list(): readonly AgentDefinition[] {
    return [...this.agentsById.values()]
  }

  /** Look up a registered agent definition by id. */
  getById(agentId: string): AgentDefinition | null {
    return this.agentsById.get(agentId) ?? null
  }
}

export function createAgentsRuntime(agents: readonly AgentDefinition[]): AgentsRuntime {
  return new AgentsRuntime(agents)
}
