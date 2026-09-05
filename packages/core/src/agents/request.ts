import { randomUUID } from "node:crypto"
import type { Principal } from "../auth"
import { SYSTEM_PRINCIPAL } from "../auth"
import { snapshotRequesterGroupIds } from "../auth/attribution"
import { assertAuthorized } from "../authorization"
import type { FileRef } from "../blob-storage"
import {
  canInheritAgentRequestAuthorization,
  createInheritedAgentExecutionRecord,
} from "../execution/agent"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { LanguageModelCatalog, LanguageModelRef } from "../models"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
  type ConversationAgentRunRecord,
  type ConversationAgentRunSpec,
} from "../storage/agents"
import type { CreateExecutionInput } from "../storage/executions"
import type { AgentContextEntryInput } from "./context"
import { resolveAgentContextParts } from "./context-resolution"
import { dispatchQueuedAgentRuns } from "./dispatch"
import { AgentRequestError } from "./errors"
import { createAgentMessageId, createAgentRunId, createAgentThreadId } from "./ids"
import { assertNoAgentSelector } from "./retired-config"
import { publishAgentRunActivity } from "./streams"
import { AGENT_REASONING_LEVELS, type AgentReasoningLevel } from "./types"

export interface RequestAgentRunInput {
  /** The user's message that triggers the turn. */
  readonly text: string
  /** Blob-backed files attached to the trigger message. */
  readonly attachments?: readonly FileRef[]
  /** Structured page/object context snapshotted onto the triggering user message. */
  readonly context?: readonly AgentContextEntryInput[]
  /** Continue an existing thread. Omitted → a fresh thread is created for this agent. */
  readonly threadId?: string
  /** Configured language model selected for this turn. Omitted uses the agent default. */
  readonly model?: LanguageModelRef
  /** Provider-neutral reasoning effort selected for this turn. */
  readonly reasoning?: AgentReasoningLevel
  /** Title to stamp on the thread when one is created. */
  readonly title?: string
  /** Explicit id for the trigger (user) message. Defaults to a generated id. */
  readonly messageId?: string
  /** Caller principal for privileged integrations; scoped runtimes use their authorization principal. */
  readonly principal?: Principal
}

export interface RequestAgentRunResult {
  /** The durable queued run exactly as it was created (`status: "queued"`, attempt 0). */
  readonly run: ConversationAgentRunRecord
  /** The enqueued job id, when the queue returns one. */
  readonly jobId?: string
  /** Whether this call created the thread. */
  readonly createdThread: boolean
}

/**
 * Trigger an agent turn.
 *
 * The user message and a `queued` run are persisted atomically before the queue intent is
 * published. This makes accepted work visible immediately and lets refresh reconstruct queue state.
 * The run's thread claim is the single-flight authority; a second request receives
 * `active_run_exists` before it can leave an orphan message.
 */
export async function requestAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  assertNoAgentSelector(input)
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const spec = resolveConversationRunSpec({ models, input })

  // Resolve context before creating a thread: invalid or inaccessible references must not leave an
  // empty conversation behind. The resulting parts are the exact snapshot persisted below.
  const contextParts = await resolveAgentContextParts(runtime, input.context)

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  // A scoped runtime is authoritative for caller identity. `input.principal` remains available to
  // privileged server integrations that have already authenticated their request.
  const principal = runtime.authorization?.principal ?? input.principal ?? SYSTEM_PRINCIPAL
  const { thread, createdThread } = await resolveThread(agents, {
    projectId,
    threadId: input.threadId,
    title: input.title,
    principal,
  })

  // Fast single-flight check for a clear error. `runs.create` below is the atomic authority.
  if (thread.activeRunId !== null) {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }

  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  const requesterGroupIds = durableExecution.requestedBy
    ? await snapshotRequesterGroupIds({
        auth: runtime.storage.auth,
        projectId,
        principal: durableExecution.requestedBy,
      })
    : []
  const triggerMessageId = input.messageId ?? createAgentMessageId()
  let run: ConversationAgentRunRecord
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      await tx.executions.create(durableExecution)
      await agents.messages.append({
        id: triggerMessageId,
        projectId,
        threadId: thread.id,
        runId: null,
        role: "user",
        parts: [
          ...contextParts,
          { type: "text", text: input.text },
          ...(input.attachments ?? []).map((fileRef) => ({ type: "file" as const, fileRef })),
        ],
        authorPrincipal: principal,
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: thread.id,
        triggerMessageId,
        spec,
        requesterGroupIds,
      })
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      throw new AgentRequestError("active_run_exists", error.message)
    }
    throw error
  }

  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)

  return {
    run,
    ...(jobId ? { jobId } : {}),
    createdThread,
  }
}

/** Retry a failed turn as a new child execution while reusing its immutable trigger message. */
export async function retryAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  failedRun: ConversationAgentRunRecord
): Promise<RequestAgentRunResult> {
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  if (failedRun.status !== "failed") {
    throw new AgentRequestError(
      "run_not_retryable",
      `[Sixb] Only failed Agent runs can be retried.`
    )
  }

  const agents = requireAgentStorage(runtime)
  const thread = await agents.threads.getById({
    projectId: runtime.projectId,
    id: failedRun.threadId,
  })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${failedRun.threadId}' was not found.`
    )
  }
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  const requesterGroupIds = durableExecution.requestedBy
    ? await snapshotRequesterGroupIds({
        auth: runtime.storage.auth,
        projectId: runtime.projectId,
        principal: durableExecution.requestedBy,
      })
    : []
  const run = await runtime.storage.transaction(async (tx) => {
    const agents = tx.agents
    if (!agents) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    await agents.messages.deleteByRunId({
      projectId: runtime.projectId,
      threadId: failedRun.threadId,
      runId: failedRun.id,
    })
    await tx.executions.create(durableExecution)
    return agents.runs.create({
      id: runId,
      projectId: runtime.projectId,
      executionId: durableExecution.id,
      threadId: failedRun.threadId,
      triggerMessageId: failedRun.triggerMessageId,
      spec:
        failedRun.spec ??
        resolveConversationRunSpec({
          models,
          input: {},
        }),
      requesterGroupIds,
    })
  })
  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)
  return { run, ...(jobId ? { jobId } : {}), createdThread: false }
}

function resolveConversationRunSpec(input: {
  readonly models?: LanguageModelCatalog
  readonly input: Pick<RequestAgentRunInput, "model" | "reasoning">
}): ConversationAgentRunSpec {
  if (!input.models) {
    throw new AgentRequestError(
      "model_not_found",
      "[Sixb] Configure models.language before starting the Agent."
    )
  }
  const selected = input.input.model ?? input.models.default
  const model = input.models.getByRef(selected)
  if (model === null) {
    throw new AgentRequestError(
      "model_not_found",
      `[Sixb] Language model '${selected.provider}/${selected.modelId}' is not in the project model catalog.`
    )
  }

  const reasoning = input.input.reasoning
  if (
    reasoning !== undefined &&
    !(AGENT_REASONING_LEVELS as readonly string[]).includes(reasoning)
  ) {
    throw new AgentRequestError(
      "invalid_model_selection",
      `[Sixb] Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}.`
    )
  }

  return Object.freeze({
    model: Object.freeze({ provider: selected.provider, modelId: selected.modelId }),
    ...(reasoning === undefined ? {} : { reasoning }),
  })
}

async function prepareDurableAgentExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  runId: string
): Promise<CreateExecutionInput> {
  const parent = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )
  return createInheritedAgentExecutionRecord({
    id: `exec_${randomUUID()}`,
    parent,
    runId,
  })
}

function assertRequestAuthorityCanRunAgent(runtime: SixbRuntimeContext): void {
  if (!canInheritAgentRequestAuthorization(runtime.runtimeAuthorization)) {
    throw new AgentRequestError(
      "authority_not_inheritable",
      "[Sixb] The Agent requires an authenticated user request or disabled authorization."
    )
  }
}

async function dispatchAgentRun(
  runtime: SixbRuntimeContext,
  agents: AgentStorage,
  runId: string
): Promise<string | undefined> {
  // The queued run is the durable dispatch intent. Publication is best-effort; workers reconcile
  // it with the same deterministic queue job id if the queue is temporarily unavailable.
  try {
    const dispatch = await dispatchQueuedAgentRuns({
      projectId: runtime.projectId,
      storage: agents,
      queue: runtime.queues.agents,
      runIds: [runId],
    })
    const failure = dispatch.failures[0]
    if (failure) {
      console.error(
        `[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`,
        failure.error
      )
    }
    return dispatch.dispatched[0]?.jobId
  } catch (error) {
    console.error(`[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`, error)
    return undefined
  }
}

/** Activity delivery is observational: durable run admission remains successful if the feed is down. */
async function publishRunActivity(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunActivity(runtime.broker, run)
  } catch (error) {
    console.error(`[Sixb] Agent run '${run.id}' activity stream publish failed:`, error)
  }
}

async function resolveThread(
  agents: AgentStorage,
  params: {
    readonly projectId: string
    readonly threadId?: string
    readonly title?: string
    readonly principal: Principal
  }
): Promise<{ thread: AgentThreadRecord; createdThread: boolean }> {
  if (params.threadId) {
    const existing = await agents.threads.getById({
      projectId: params.projectId,
      id: params.threadId,
    })
    if (existing) {
      return { thread: existing, createdThread: false }
    }
  }

  const thread = await agents.threads.create({
    id: params.threadId ?? createAgentThreadId(),
    projectId: params.projectId,
    ownerPrincipal: params.principal,
    ...(params.title === undefined ? {} : { title: params.title }),
  })
  return { thread, createdThread: true }
}

function requireAgentStorage(runtime: SixbRuntimeContext): AgentStorage {
  const agents = runtime.storage.agents
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return agents
}
