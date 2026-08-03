import { agentRequestError } from "../agents/errors"
import type { Principal } from "../auth"
import { SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized } from "../authorization"
import type { FileRef } from "../blob-storage"
import { reportBackgroundTaskFailure } from "../error-reporting/capability"
import { isSixbError } from "../errors"
import type { SixbRuntimeContext } from "../runtime/types"
import type { AgentRunRecord, AgentStorage, AgentThreadRecord } from "../storage/agents"
import { agentStorageErrorReason } from "../storage/agents"
import type { AgentContextEntryInput } from "./context"
import { resolveAgentContextParts } from "./context-resolution"
import { dispatchQueuedAgentRuns } from "./dispatch"
import { createAgentMessageId, createAgentRunId, createAgentThreadId } from "./ids"
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
  /** Owner principal for a newly created thread. Defaults to the system principal until auth lands. */
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
  agent: AgentDefinition,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  assertAuthorized(runtime, { kind: "agent.run", agentId: agent.id })

  // Resolve context before creating a thread: invalid or inaccessible references must not leave an
  // empty conversation behind. The resulting parts are the exact snapshot persisted below.
  const contextParts = await resolveAgentContextParts(runtime, input.context)

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const principal = input.principal ?? SYSTEM_PRINCIPAL

  const { thread, createdThread } = await resolveThread(agents, {
    projectId,
    agentId: agent.id,
    threadId: input.threadId,
    title: input.title,
    principal,
  })

  // Fast single-flight check for a clear error. `runs.create` below is the atomic authority.
  if (thread.activeRunId !== null) {
    throw agentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }

  const runId = createAgentRunId()
  const triggerMessageId = input.messageId ?? createAgentMessageId()
  let run: AgentRunRecord
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw agentRequestError("storage_not_configured", "[Sixb] Agent storage is not configured.")
      }
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
        threadId: thread.id,
        agentId: agent.id,
        triggerMessageId,
        requestedByPrincipal: principal,
      })
    })
  } catch (error) {
    if (isSixbError(error) && agentStorageErrorReason(error) === "active_run_exists") {
      throw agentRequestError("active_run_exists", error.message)
    }
    throw error
  }

  // The queued run is also the durable dispatch intent. Publication is best-effort here; an agent
  // worker scans queued runs and retries with the same deterministic queue job id.
  let jobId: string | undefined
  try {
    const dispatch = await dispatchQueuedAgentRuns({
      projectId,
      storage: agents,
      queue: runtime.queues.agents,
      runIds: [runId],
    })
    jobId = dispatch.dispatched[0]?.jobId
    const failure = dispatch.failures[0]
    if (failure) {
      reportDispatchFailure(runtime, failure.error, runId)
    }
  } catch (error) {
    reportDispatchFailure(runtime, error, runId)
  }

  return {
    run,
    ...(jobId ? { jobId } : {}),
    createdThread,
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
        throw agentRequestError(
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
    throw agentRequestError("storage_not_configured", "[Sixb] Agent storage is not configured.")
  }
  return agents
}

/**
 * The run is queued and durable at this point, so a failed publication is not the caller's problem:
 * an agent worker scans queued runs and retries with the same deterministic job id. It is the
 * operator's, because until that scan lands the run sits there doing nothing.
 */
function reportDispatchFailure(runtime: SixbRuntimeContext, error: unknown, runId: string): void {
  reportBackgroundTaskFailure(runtime, error, {
    projectId: runtime.projectId,
    task: "agent.dispatch",
    subject: runId,
  })
}
