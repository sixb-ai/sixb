import type { Principal } from "../auth"
import type { SixbRuntimeContext } from "../runtime/types"
import type { AgentStorage, AgentThreadRecord } from "../storage/agents"
import { AgentRequestError } from "./errors"
import { createAgentMessageId, createAgentThreadId } from "./ids"
import type { AgentDefinition } from "./types"

export interface RequestAgentRunInput {
  /** The agent to run. */
  readonly agentId: string
  /** The user's message that triggers the turn. V1 input is plain text. */
  readonly text: string
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
  /** The thread the turn runs in (created when no `threadId` was supplied). */
  readonly threadId: string
  /** The persisted user message that triggers the run. */
  readonly triggerMessageId: string
  /** The enqueued job id, when the queue returns one. */
  readonly jobId?: string
  /** Whether this call created the thread. */
  readonly createdThread: boolean
}

const SYSTEM_PRINCIPAL: Principal = { type: "system", id: "system" }

/**
 * Trigger an agent turn.
 *
 * Reserve-at-claim: this only persists the user message and enqueues an *intent* — no `agent_runs`
 * record is created here. The worker generates the run id and reserves the run when it claims the
 * job, so it owns the lease from birth and there is never an orphan run between request and pickup.
 *
 * Single-flight is enforced at two layers: this trigger rejects a second message while a run is
 * already active (`active_run_exists`, surfaced to the caller — the HTTP layer maps it to 409), and
 * the worker's atomic `runs.reserve` is the ultimate authority on the race + crash redelivery.
 */
export async function requestAgentRun(
  runtime: SixbRuntimeContext,
  agent: AgentDefinition,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId

  const { thread, createdThread } = await resolveThread(agents, {
    projectId,
    agentId: agent.id,
    threadId: input.threadId,
    title: input.title,
    principal: input.principal ?? SYSTEM_PRINCIPAL,
  })

  // Single-flight (trigger layer): a thread runs one turn at a time in V1. The worker's `reserve`
  // is the atomic authority, but rejecting here avoids persisting an orphan message we cannot serve.
  if (thread.activeRunId !== null) {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }

  const triggerMessageId = input.messageId ?? createAgentMessageId()
  await agents.messages.append({
    id: triggerMessageId,
    projectId,
    threadId: thread.id,
    runId: null,
    role: "user",
    parts: [{ type: "text", text: input.text }],
  })

  // Enqueue the intent. Nothing to roll back on failure: no run was reserved, and the user message
  // is durable — the caller may retry, which re-enqueues against the same thread.
  const [job] = await runtime.queues.agents.enqueue({
    projectId,
    jobs: [
      {
        type: "agent.run.requested",
        payload: { agentId: agent.id, threadId: thread.id, triggerMessageId },
      },
    ],
  })

  return {
    threadId: thread.id,
    triggerMessageId,
    ...(job?.id ? { jobId: job.id } : {}),
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
