import { principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized, isAllowed } from "../authorization"
import type { AuthorizablePrincipal, ExecutionContext } from "../execution"
import type { ModelCatalog } from "../models"
import { resolveExecutionCosts } from "../runtime/ai-cost"
import { resolveExecutionUsage } from "../runtime/ai-usage"
import type { SixbRuntimeContext } from "../runtime/types"
import type {
  AgentThreadRecord,
  ConversationAgentRunRecord,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
} from "../storage/agents"
import type { AiCostSummary } from "../storage/ai-cost"
import type { AiModelCallUsage } from "../storage/ai-usage"
import { AgentRequestError } from "./errors"
import { createAgentThreadId } from "./ids"
import {
  type RequestAgentRunInput,
  type RequestAgentRunResult,
  requestAgentRun,
  retryAgentRun,
} from "./request"
import { assertNoAgentSelector } from "./retired-config"
import type { AgentDescriptor } from "./types"

export type ExecutionAgentRequestInput = Omit<RequestAgentRunInput, "principal">
export type ListExecutionAgentThreadsInput = Omit<
  ListAgentThreadsInput,
  "projectId" | "ownerPrincipal"
>

export interface CreateExecutionAgentThreadInput {
  readonly id?: string
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
export interface AgentRunView extends ConversationAgentRunRecord {
  readonly requestedBy?: AuthorizablePrincipal
  /** Derived from the model-call ledger; never persisted on the Agent run row. */
  readonly usage?: AiModelCallUsage
  /** Preferred valuation; omitted when there are no calls or cost storage is unavailable. */
  readonly cost?: AiCostSummary
}

export interface AgentRunListResult extends Omit<ListAgentRunsResult, "runs"> {
  readonly runs: readonly AgentRunView[]
}

export interface ExecutionAgentRunResult extends Omit<RequestAgentRunResult, "run"> {
  readonly run: AgentRunView
}

export interface AgentRuntime {
  /** Null when no language models are configured or the caller cannot run the Agent. */
  get(): AgentDescriptor | null
  readonly threads: AgentThreadsRuntime
  readonly runs: AgentRunsRuntime
}

export function createAgentRuntime(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models?: ModelCatalog
): AgentRuntime {
  const principal = runtime.authorization?.principal ?? SYSTEM_PRINCIPAL
  const allowed = () => isAllowed(runtime.authorization, { kind: "agent.run" })

  const getVisibleThreadRecord = async (threadId: string): Promise<AgentThreadRecord | null> => {
    const thread =
      (await runtime.storage.agents?.threads.getById({
        projectId: runtime.projectId,
        id: threadId,
      })) ?? null
    if (!thread || !allowed()) return null
    return runtime.authorization && !principalsEqual(principal, thread.ownerPrincipal)
      ? null
      : thread
  }

  const getAgent = (): AgentDescriptor | null => {
    const model = models?.language.default
    if (!model || !allowed()) return null
    return {
      name: "Sixb",
      model: { provider: model.provider, modelId: model.modelId },
    }
  }

  const getVisibleRunRecord = async (runId: string): Promise<ConversationAgentRunRecord | null> => {
    const run =
      (await runtime.storage.agents?.runs.getById({
        projectId: runtime.projectId,
        id: runId,
      })) ?? null
    if (!run || run.kind !== "conversation") return null
    const thread = await getVisibleThreadRecord(run.threadId)
    return thread ? run : null
  }

  const getRun = async (runId: string): Promise<AgentRunView | null> => {
    const run = await getVisibleRunRecord(runId)
    return run ? attachRunView(runtime, run) : null
  }

  return {
    get: getAgent,
    threads: {
      create: async (input) => {
        assertNoAgentSelector(input)
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
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
          ownerPrincipal: principal,
          ...(input.title === undefined ? {} : { title: input.title }),
        })
      },
      getById: getVisibleThreadRecord,
      list: async (input = {}) => {
        assertNoAgentSelector(input)
        const storage = runtime.storage.agents
        if (!storage || !allowed()) return { threads: [], hasMore: false, total: 0 }
        return storage.threads.list({
          ...input,
          projectId: runtime.projectId,
          ownerPrincipal: runtime.authorization ? principal : undefined,
        })
      },
    },
    runs: {
      request: async (input) => {
        assertNoAgentSelector(input)
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }
        assertAuthorized(runtime, { kind: "agent.run" })
        if (input.threadId && !(await getVisibleThreadRecord(input.threadId))) {
          throw new AgentRequestError(
            "thread_not_found",
            `[Sixb] Agent thread '${input.threadId}' not found.`
          )
        }
        const result = await requestAgentRun(runtime, execution, models?.language, {
          ...input,
          principal,
        })
        return { ...result, run: await attachRunView(runtime, result.run) }
      },
      retry: async (runId) => {
        const failedRun = await getVisibleRunRecord(runId)
        if (!failedRun) {
          throw new AgentRequestError("run_not_found", `[Sixb] Agent run '${runId}' was not found.`)
        }
        const agent = getAgent()
        if (!agent) {
          throw new AgentRequestError("agent_not_found", "[Sixb] The project Agent is unavailable.")
        }
        const result = await retryAgentRun(runtime, execution, models?.language, failedRun)
        return { ...result, run: await attachRunView(runtime, result.run) }
      },
      getById: getRun,
      listForThread: async (threadId, input = {}) => {
        assertNoAgentSelector(input)
        const storage = runtime.storage.agents
        if (!storage || !(await getVisibleThreadRecord(threadId))) return null
        const result = await storage.runs.list({
          ...input,
          projectId: runtime.projectId,
          threadId,
        })
        return {
          ...result,
          runs: await attachRunViews(
            runtime,
            result.runs.filter((run) => run.kind === "conversation")
          ),
        }
      },
    },
  }
}

async function attachRunView(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<AgentRunView> {
  const [view] = await attachRunViews(runtime, [run])
  if (!view) throw new Error(`[Sixb] Could not build Agent run '${run.id}' view.`)
  return view
}

async function attachRunViews(
  runtime: SixbRuntimeContext,
  runs: readonly ConversationAgentRunRecord[]
): Promise<readonly AgentRunView[]> {
  const executionIds = runs.map((run) => run.executionId)
  const [executions, usages, costs] = await Promise.all([
    Promise.all(
      runs.map((run) =>
        runtime.storage.executions.getById({
          projectId: runtime.projectId,
          id: run.executionId,
        })
      )
    ),
    resolveExecutionUsage({
      storage: runtime.storage.aiUsage,
      projectId: runtime.projectId,
      executionIds,
    }),
    resolveExecutionCosts({
      storage: runtime.storage.aiCosts,
      projectId: runtime.projectId,
      executionIds,
    }),
  ])

  return runs.map((run, index) => {
    const execution = executions[index]
    if (!execution) {
      throw new Error(
        `[Sixb] Agent run '${run.id}' references missing execution '${run.executionId}'.`
      )
    }
    const usage = usages[index]
    const cost = usage === undefined ? undefined : costs[index]
    return {
      ...run,
      ...(execution.requestedBy === undefined
        ? {}
        : { requestedBy: structuredClone(execution.requestedBy) }),
      ...(usage === undefined ? {} : { usage }),
      ...(cost === undefined ? {} : { cost }),
    }
  })
}
