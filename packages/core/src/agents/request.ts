import { randomUUID } from "node:crypto"
import type { Principal } from "../auth"
import { SYSTEM_PRINCIPAL } from "../auth"
import { snapshotRequesterGroupIds } from "../auth/attribution"
import { assertAuthorized } from "../authorization"
import type { FileRef } from "../blob-storage"
import { createAgentExecutionRecord } from "../execution/agent"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type { SixbRuntimeContext } from "../runtime/types"
import type { SecurityDefinitionCatalog } from "../security"
import {
  type AgentRunRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadRecord,
} from "../storage/agents"
import type { CreateExecutionInput } from "../storage/executions"
import { ensureAgentExecutionIdentity, resolveAgentExecutionAuthorization } from "./authority"
import type { AgentContextEntryInput } from "./context"
import { resolveAgentContextParts } from "./context-resolution"
import { dispatchQueuedAgentRuns } from "./dispatch"
import { AgentRequestError } from "./errors"
import { createAgentMessageId, createAgentRunId, createAgentThreadId } from "./ids"
import { MAIN_AGENT_ID } from "./main-agent"
import type { AgentDefinition } from "./types"

export interface RequestAgentRunInput {
  /** The agent to run. */
  readonly agentId: string
  /** The user's message that triggers the turn. */
  readonly text: string
  /** Blob-backed files attached to the trigger message. */
  readonly attachments?: readonly FileRef[]
  /** Structured page/object context snapshotted onto the triggering user message. */
  readonly context?: readonly AgentContextEntryInput[]
  /** Continue an existing thread. Omitted → a fresh thread is created for this agent. */
  readonly threadId?: string
  /** Title to stamp on the thread when one is created. */
  readonly title?: string
  /** Explicit id for the trigger (user) message. Defaults to a generated id. */
  readonly messageId?: string
  /** Caller principal for privileged integrations; scoped runtimes use their authorization principal. */
  readonly principal?: Principal
}

export interface RequestAgentRunResult {
  /** The durable queued run exactly as it was created (`status: "queued"`, attempt 0). */
  readonly run: AgentRunRecord
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
  security: SecurityDefinitionCatalog,
  agent: AgentDefinition,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  assertAuthorized(runtime, { kind: "agent.run", agentId: agent.id })

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
    agentId: agent.id,
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
  const durableExecution = await prepareDurableAgentExecution(
    runtime,
    execution,
    security,
    agent,
    runId
  )
  const requesterGroupIds = durableExecution.requestedBy
    ? await snapshotRequesterGroupIds({
        auth: runtime.storage.auth,
        projectId,
        principal: durableExecution.requestedBy,
      })
    : []
  const triggerMessageId = input.messageId ?? createAgentMessageId()
  let run: AgentRunRecord
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
        agentId: agent.id,
        triggerMessageId,
        requesterGroupIds,
        requesterAuthorizationGroupIds: runtime.authorization?.groupIds ?? [],
      })
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      throw new AgentRequestError("active_run_exists", error.message)
    }
    throw error
  }

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
  security: SecurityDefinitionCatalog,
  agent: AgentDefinition,
  failedRun: AgentRunRecord
): Promise<RequestAgentRunResult> {
  assertAuthorized(runtime, { kind: "agent.run", agentId: agent.id })
  if (failedRun.agentId !== agent.id) {
    throw new AgentRequestError(
      "agent_not_found",
      `[Sixb] Agent run '${failedRun.id}' does not belong to agent '${agent.id}'.`
    )
  }
  if (failedRun.status !== "failed") {
    throw new AgentRequestError(
      "run_not_retryable",
      `[Sixb] Only failed Agent runs can be retried.`
    )
  }

  const agents = requireAgentStorage(runtime)
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(
    runtime,
    execution,
    security,
    agent,
    runId
  )
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
    await tx.executions.create(durableExecution)
    return agents.runs.create({
      id: runId,
      projectId: runtime.projectId,
      executionId: durableExecution.id,
      threadId: failedRun.threadId,
      agentId: agent.id,
      triggerMessageId: failedRun.triggerMessageId,
      requesterGroupIds,
      requesterAuthorizationGroupIds: runtime.authorization?.groupIds ?? [],
    })
  })
  const jobId = await dispatchAgentRun(runtime, agents, runId)
  return { run, ...(jobId ? { jobId } : {}), createdThread: false }
}

async function prepareDurableAgentExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  security: SecurityDefinitionCatalog,
  agent: AgentDefinition,
  runId: string
): Promise<CreateExecutionInput> {
  const identity = await ensureAgentExecutionIdentity({
    auth: runtime.storage.auth,
    projectId: runtime.projectId,
    agent,
  })
  const resolved = await resolveAgentExecutionAuthorization({
    auth: runtime.storage.auth,
    projectId: runtime.projectId,
    agentId: agent.id,
    authorizationRef: { type: "principal", principal: identity.principal },
    security,
  })
  const parent = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )
  // The framework-managed main agent acts as the human who asked for the turn, so it reaches
  // exactly what they can reach without being given groups of its own. Every other agent — and a
  // main-agent turn with no human behind it — acts as its own managed identity.
  const delegated = agent.id === MAIN_AGENT_ID ? parent.requestedBy : undefined
  return createAgentExecutionRecord({
    id: `exec_${randomUUID()}`,
    parent,
    agentId: agent.id,
    runId,
    principal: delegated ?? resolved.identity.principal,
  })
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

async function resolveThread(
  agents: AgentStorage,
  params: {
    readonly projectId: string
    readonly agentId: string
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
      if (existing.agentId !== params.agentId) {
        throw new AgentRequestError(
          "thread_agent_mismatch",
          `[Sixb] Agent thread '${existing.id}' belongs to agent '${existing.agentId}', not '${params.agentId}'.`
        )
      }
      return { thread: existing, createdThread: false }
    }
  }

  const thread = await agents.threads.create({
    id: params.threadId ?? createAgentThreadId(),
    projectId: params.projectId,
    agentId: params.agentId,
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
