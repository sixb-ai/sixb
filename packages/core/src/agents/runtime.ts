import type { AgentDefinition } from "./types"

/**
 * Holds the agent definitions registered with a Sixb instance and exposes lookup.
 *
 * The PR1 surface is definition-only (`list` / `getById`). Runtime behaviour
 * (starting a run, streaming) lands in later slices on this same `sixb.agents`
 * namespace, mirroring `sixb.workflows` / `sixb.actions`.
 *
 * Duplicate ids are rejected by the `Sixb` constructor before this is built.
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
