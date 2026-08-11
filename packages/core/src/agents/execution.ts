import { principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized, isAllowed } from "../authorization"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentRunRecord,
  AgentThreadRecord,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
} from "../storage/agents"
import { AgentRequestError } from "./errors"
import { createAgentThreadId } from "./ids"
import { type RequestAgentRunInput, type RequestAgentRunResult, requestAgentRun } from "./request"
import type { AgentDefinition } from "./types"

export type ExecutionAgentRequestInput = Omit<RequestAgentRunInput, "principal">
export type ListExecutionAgentThreadsInput = Omit<
  ListAgentThreadsInput,
  "projectId" | "agentIds" | "ownerPrincipal"
>

export interface CreateExecutionAgentThreadInput {
  readonly id?: string
  readonly agentId: string
  readonly title?: string
}

export interface ExecutionAgentThreadsRuntime {
  create(input: CreateExecutionAgentThreadInput): Promise<AgentThreadRecord>
  getById(threadId: string): Promise<AgentThreadRecord | null>
  list(input?: ListExecutionAgentThreadsInput): Promise<ListAgentThreadsResult>
}

export interface ExecutionAgentRunsRuntime {
  request(input: ExecutionAgentRequestInput): Promise<RequestAgentRunResult>
  getById(runId: string): Promise<AgentRunRecord | null>
  listForThread(
    threadId: string,
    input?: Omit<ListAgentRunsInput, "projectId" | "threadId">
  ): Promise<ListAgentRunsResult | null>
}

export interface ExecutionAgentsRuntime {
  list(): readonly AgentDefinition[]
  getById(agentId: string): AgentDefinition | null
  readonly threads: ExecutionAgentThreadsRuntime
  readonly runs: ExecutionAgentRunsRuntime
}

export function createExecutionAgentsRuntime(
  runtime: SixbRuntimeContext,
  source: Pick<ExecutionAgentsRuntime, "list" | "getById">
): ExecutionAgentsRuntime {
  const principal = runtime.authorization?.principal ?? SYSTEM_PRINCIPAL
  const allowed = (agentId: string) =>
    isAllowed(runtime.authorization, { kind: "agent.run", agentId })

  const getThread = async (threadId: string) => {
    const thread =
      (await runtime.storage.agents?.threads.getById({
        projectId: runtime.projectId,
        id: threadId,
      })) ?? null
    if (!thread || !allowed(thread.agentId)) return null
    return runtime.authorization && !principalsEqual(principal, thread.ownerPrincipal)
      ? null
      : thread
  }

  const getAgent = (agentId: string) => {
    const agent = source.getById(agentId)
    return agent && allowed(agentId) ? agent : null
  }

  return {
    list: () => source.list().filter((agent) => allowed(agent.id)),
    getById: getAgent,
    threads: {
      create: async (input) => {
        const agent = getAgent(input.agentId)
        if (!agent) {
          throw new AgentRequestError("agent_not_found", `[Sixb] Unknown agent '${input.agentId}'.`)
        }
        const storage = runtime.storage.agents
        if (!storage) {
          throw new AgentRequestError(
            "storage_unavailable",
            "[Sixb] Agent storage is not configured."
          )
        }
        return storage.threads.create({
          id: input.id ?? createAgentThreadId(),
          projectId: runtime.projectId,
          agentId: agent.id,
          ownerPrincipal: principal,
          ...(input.title === undefined ? {} : { title: input.title }),
        })
      },
      getById: getThread,
      list: (input = {}) => {
        const storage = runtime.storage.agents
        if (!storage) return Promise.resolve({ threads: [], hasMore: false, total: 0 })
        return storage.threads.list({
          projectId: runtime.projectId,
          ...input,
          agentIds: runtime.authorization
            ? [...runtime.authorization.grants["run:agent"]]
            : undefined,
          ownerPrincipal: runtime.authorization ? principal : undefined,
        })
      },
    },
    runs: {
      request: async (input) => {
        const agent = source.getById(input.agentId)
        if (!agent) {
          throw new AgentRequestError("agent_not_found", `[Sixb] Unknown agent '${input.agentId}'.`)
        }
        assertAuthorized(runtime, { kind: "agent.run", agentId: agent.id })
        if (input.threadId && !(await getThread(input.threadId))) {
          throw new AgentRequestError(
            "thread_not_found",
            `[Sixb] Agent thread '${input.threadId}' not found.`
          )
        }
        return requestAgentRun(runtime, agent, { ...input, principal })
      },
      getById: async (runId) => {
        const run =
          (await runtime.storage.agents?.runs.getById({
            projectId: runtime.projectId,
            id: runId,
          })) ?? null
        if (!run) return null
        const thread = await getThread(run.threadId)
        return thread?.agentId === run.agentId ? run : null
      },
      listForThread: async (threadId, input = {}) => {
        const storage = runtime.storage.agents
        if (!storage || !(await getThread(threadId))) return null
        return storage.runs.list({
          projectId: runtime.projectId,
          ...input,
          threadId,
        })
      },
    },
  }
}
