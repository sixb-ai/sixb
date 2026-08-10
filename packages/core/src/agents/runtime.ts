import { principalsEqual } from "../auth"
import { isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentThreadRecord,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
} from "../storage/agents"
import { AgentRequestError } from "./errors"
import { type RequestAgentRunInput, type RequestAgentRunResult, requestAgentRun } from "./request"
import type { AgentDefinition } from "./types"

/** The caller-supplied part of a thread listing; owner + grant filters are derived from the runtime. */
export type ScopedListAgentThreadsInput = Omit<
  ListAgentThreadsInput,
  "projectId" | "agentIds" | "ownerPrincipal"
>

/**
 * Whether a runtime may read a thread: privileged runtimes (no authorization) always may; a scoped
 * runtime may only read threads it owns AND holds `run:agent` on. This is the single owner+grant
 * rule for agent thread reads — the server routes it through {@link ScopedSixb.agents.getThread}.
 */
function canAccessThread(
  authorization: SixbRuntimeContext["authorization"],
  thread: AgentThreadRecord
): boolean {
  return (
    !authorization ||
    (principalsEqual(authorization.principal, thread.ownerPrincipal) &&
      isAllowed(authorization, { kind: "agent.run", agentId: thread.agentId }))
  )
}

/**
 * Holds the agent definitions registered with a Sixb instance and exposes lookup + the run trigger.
 *
 * Definition lookup (`list` / `getById`) is what the worker uses to resolve a run's model (the model
 * is a non-serialisable language model, so it is never sent over the wire). `request(...)` is the
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

  /** Trigger an agent turn: persist its queued run and user message, then dispatch the intent. */
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

  /**
   * List threads visible to an explicit runtime. A scoped runtime is filtered to threads it owns and
   * holds `run:agent` on (via the storage `agentIds` + `ownerPrincipal` filters); a privileged
   * runtime sees all. Missing agent storage yields an empty page rather than throwing, so a
   * listing on an agent-less deployment degrades gracefully.
   */
  async listThreadsAs(
    runtime: SixbRuntimeContext,
    input: ScopedListAgentThreadsInput = {}
  ): Promise<ListAgentThreadsResult> {
    const storage = runtime.storage.agents
    if (!storage) {
      return { threads: [], hasMore: false, total: 0 }
    }
    const authz = runtime.authorization
    return storage.threads.list({
      projectId: runtime.projectId,
      agentId: input.agentId,
      // Present authz => filter to runnable agents (an empty grant set yields an empty page);
      // absent authz (privileged) => no filter.
      agentIds: authz ? [...authz.grants["run:agent"]] : undefined,
      statuses: input.statuses,
      ownerPrincipal: authz?.principal,
      limit: input.limit,
      offset: input.offset,
      order: input.order,
    })
  }

  /** Read a single thread through the runtime's scope; returns null when absent or inaccessible. */
  async getThreadAs(
    runtime: SixbRuntimeContext,
    threadId: string
  ): Promise<AgentThreadRecord | null> {
    const storage = runtime.storage.agents
    if (!storage) {
      return null
    }
    const thread = await storage.threads.getById({ projectId: runtime.projectId, id: threadId })
    return thread && canAccessThread(runtime.authorization, thread) ? thread : null
  }
}

export function createAgentsRuntime(
  runtime: SixbRuntimeContext,
  agents: readonly AgentDefinition[]
): AgentsRuntime {
  return new AgentsRuntime(runtime, agents)
}
