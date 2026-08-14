import { principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized, isAllowed } from "../authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SecurityDefinitionCatalog } from "../security"
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
import {
  type RequestAgentRunInput,
  type RequestAgentRunResult,
  requestAgentRun,
  retryAgentRun,
} from "./request"
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

export interface AgentThreadsRuntime {
  create(input: CreateExecutionAgentThreadInput): Promise<AgentThreadRecord>
  getById(threadId: string): Promise<AgentThreadRecord | null>
  list(input?: ListExecutionAgentThreadsInput): Promise<ListAgentThreadsResult>
}

export interface AgentRunsRuntime {
  request(input: ExecutionAgentRequestInput): Promise<ExecutionAgentRunResult>
  retry(runId: string): Promise<ExecutionAgentRunResult>
  getById(runId: string): Promise<AgentRunView | null>
  listForThread(
    threadId: string,
    input?: Omit<ListAgentRunsInput, "projectId" | "threadId">
  ): Promise<AgentRunListResult | null>
}

/** Execution-facing run view with provenance resolved from the immutable execution ledger. */
export interface AgentRunView extends AgentRunRecord {
  readonly requestedBy?: AuthorizablePrincipal
}

export interface AgentRunListResult extends Omit<ListAgentRunsResult, "runs"> {
  readonly runs: readonly AgentRunView[]
}

export interface ExecutionAgentRunResult extends Omit<RequestAgentRunResult, "run"> {
  readonly run: AgentRunView
}

export interface AgentsRuntime {
  list(): readonly AgentDefinition[]
  getById(agentId: string): AgentDefinition | null
  readonly threads: AgentThreadsRuntime
  readonly runs: AgentRunsRuntime
}

export function createAgentsRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  source: Pick<AgentsRuntime, "list" | "getById">,
  security: SecurityDefinitionCatalog
): AgentsRuntime {
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

  const getRun = async (runId: string): Promise<AgentRunView | null> => {
    const run =
      (await runtime.storage.agents?.runs.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    if (!run) return null
    const thread = await getThread(run.threadId)
    return thread?.agentId === run.agentId ? attachRequestedBy(runtime, run) : null
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
        const result = await requestAgentRun(runtime, execution, security, agent, {
          ...input,
          principal,
        })
        return { ...result, run: await attachRequestedBy(runtime, result.run) }
      },
      retry: async (runId) => {
        const failedRun = await getRun(runId)
        if (!failedRun) {
          throw new AgentRequestError("run_not_found", `[Sixb] Agent run '${runId}' was not found.`)
        }
        const agent = getAgent(failedRun.agentId)
        if (!agent) {
          throw new AgentRequestError(
            "agent_not_found",
            `[Sixb] Unknown agent '${failedRun.agentId}'.`
          )
        }
        const result = await retryAgentRun(runtime, execution, security, agent, failedRun)
        return { ...result, run: await attachRequestedBy(runtime, result.run) }
      },
      getById: getRun,
      listForThread: async (threadId, input = {}) => {
        const storage = runtime.storage.agents
        if (!storage || !(await getThread(threadId))) return null
        const result = await storage.runs.list({
          projectId: runtime.projectId,
          ...input,
          threadId,
        })
        return {
          ...result,
          runs: await Promise.all(result.runs.map((run) => attachRequestedBy(runtime, run))),
        }
      },
    },
  }
}

async function attachRequestedBy(
  runtime: SixbRuntimeContext,
  run: AgentRunRecord
): Promise<AgentRunView> {
  const execution = await runtime.storage.executions.getById({
    projectId: runtime.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new Error(
      `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
    )
  }
  return {
    ...run,
    ...(execution.requestedBy === undefined
      ? {}
      : { requestedBy: structuredClone(execution.requestedBy) }),
  }
}
