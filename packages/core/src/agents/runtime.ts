import type { SixbRuntimeContext } from "../runtime/types"
import { AgentRequestError } from "./errors"
import { type RequestAgentRunInput, type RequestAgentRunResult, requestAgentRun } from "./request"
import type { AgentDefinition } from "./types"

/**
 * Holds the agent definitions registered with a Sixb instance and exposes lookup + the run trigger.
 *
 * Definition lookup (`list` / `getById`) is what the worker uses to resolve a run's model (the model
 * is a non-serialisable `LanguageModelV3`, so it is never sent over the wire). `request(...)` is the
 * trigger surface, mirroring `sixb.actions.request`.
 *
 * Duplicate ids are rejected by the `Sixb` constructor before this is built.
 */
export class AgentsRuntime {
  private readonly runtime: SixbRuntimeContext
  private readonly agentsById: ReadonlyMap<string, AgentDefinition>

  constructor(runtime: SixbRuntimeContext, agents: readonly AgentDefinition[]) {
    this.runtime = runtime
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

  /** Trigger an agent turn: persist the user message and enqueue the run intent. */
  request(input: RequestAgentRunInput): Promise<RequestAgentRunResult> {
    return this.requestAs(this.runtime, input)
  }

  /**
   * Trigger an agent turn on behalf of an explicit runtime context, so scoped
   * SDKs can enforce caller grants while reusing the registered definitions.
   */
  requestAs(
    runtime: SixbRuntimeContext,
    input: RequestAgentRunInput
  ): Promise<RequestAgentRunResult> {
    const agent = this.getById(input.agentId)
    if (!agent) {
      throw new AgentRequestError("agent_not_found", `[Sixb] Unknown agent '${input.agentId}'.`)
    }
    return requestAgentRun(runtime, agent, input)
  }
}
