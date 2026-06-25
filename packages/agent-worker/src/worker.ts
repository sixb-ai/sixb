import type {
  AgentDefinition,
  AgentRunLease,
  AgentRunRecord,
  AgentRunRequestedQueueJob,
  ClaimedQueueJob,
  QueueWorkerFailureDecision,
} from "@sixb/core"
import { AgentStorageError, createAgentRunId, createAgentRunLeaseId, QueueWorker } from "@sixb/core"
import { AgentLeaseHeldError, AgentLeaseLostError, AgentWorkerError } from "./errors"
import { DEFAULT_MAX_STEPS, runAgentTurn } from "./run-agent-turn"
import type { AgentWorkerContext, AgentWorkerOptions, AgentWorkerSixb, StreamSink } from "./types"

const DEFAULT_AGENT_LEASE_MS = 60_000
const SHORT_BACKOFF_MS = 250
const NOOP_SINK: StreamSink = { onPart() {} }

/** Outcome of trying to own a run for a claimed job. */
type Reservation =
  | { readonly kind: "run"; readonly run: AgentRunRecord }
  | { readonly kind: "held"; readonly availableAt: string }
  | { readonly kind: "skip" }

/**
 * Cohosted worker that turns `agent.run.requested` jobs into persisted agent runs.
 *
 * Liveness is two-layered: the queue lane delivers (and redelivers on lease expiry), while the
 * `agent_runs` lease is the sole authority on who may execute and finalize a run. The worker
 * reserves the run at claim time, owns its lease, heartbeats it during the turn, and fences every
 * write on the lease id. A run's terminal fate lives on its record (like the action worker), so
 * model/tool failures still acknowledge the job — only infra failures fail the job.
 */
export class AgentWorker extends QueueWorker<AgentRunRequestedQueueJob> {
  private readonly sixb: AgentWorkerSixb
  private readonly context: AgentWorkerContext | null
  private readonly idleWithoutAgents: boolean

  constructor(sixb: AgentWorkerSixb, options: AgentWorkerOptions = {}) {
    const leaseMs = options.leaseMs ?? DEFAULT_AGENT_LEASE_MS
    super({
      projectId: sixb.id,
      queue: sixb.queues.agents,
      workerId: `agent-worker-${sixb.id}`,
      claimLimit: 1,
      // Queue visibility ≥ run lease so a redelivered run is already reclaimable.
      leaseMs,
      idlePollMs: options.idlePollMs,
    })

    this.sixb = sixb
    this.idleWithoutAgents = sixb.agents.list().length === 0
    this.context = this.idleWithoutAgents ? null : buildAgentContext(sixb, options, leaseMs)
  }

  protected override async run(signal: AbortSignal): Promise<void> {
    if (!this.idleWithoutAgents) {
      await super.run(signal)
      return
    }
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      signal.addEventListener("abort", () => resolve(), { once: true })
    })
  }

  protected async execute(
    claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    signal: AbortSignal
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    if (job.type !== "agent.run.requested") {
      throw new AgentWorkerError(`Unsupported agent job type '${job.type}'.`)
    }

    const { agentId, threadId, triggerMessageId } = job.payload
    const agent = this.sixb.agents.getById(agentId)
    if (!agent) {
      throw new AgentWorkerError(`Unknown agent '${agentId}'.`)
    }

    const reservation = await this.reserveOrReclaim(context, { agent, threadId, triggerMessageId })
    if (reservation.kind === "skip") {
      return
    }
    if (reservation.kind === "held") {
      throw new AgentLeaseHeldError(
        reservation.availableAt,
        `Agent thread '${threadId}' has a live active run; retrying.`
      )
    }
    const run = reservation.run

    try {
      await runAgentTurn({ context, agent, run, signal })
    } catch (error) {
      if (error instanceof AgentLeaseLostError) {
        // The run was reclaimed out from under us; this delivery is a duplicate. Ack, touch nothing.
        return
      }
      const leaseId = run.lease?.id
      if (signal.aborted || isAbortError(error)) {
        if (leaseId) {
          await this.finishQuietly(context, run.id, leaseId, "cancelled", error)
        }
        throw error
      }
      // Run-level failure: record it on the run and ack the job — the fate lives on the record.
      if (leaseId) {
        await this.finishQuietly(context, run.id, leaseId, "failed", error)
      }
    }
  }

  protected override onExecutionError(
    _claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    if (error instanceof AgentLeaseHeldError) {
      return { kind: "retry", availableAt: error.availableAt }
    }
    return { kind: "fail" }
  }

  protected override onAbortError(): QueueWorkerFailureDecision {
    return { kind: "fail" }
  }

  private requireContext(): AgentWorkerContext {
    if (!this.context) {
      throw new AgentWorkerError("Agent worker has no agent storage configured.")
    }
    return this.context
  }

  private async reserveOrReclaim(
    context: AgentWorkerContext,
    input: { agent: AgentDefinition; threadId: string; triggerMessageId: string }
  ): Promise<Reservation> {
    try {
      const run = await context.storage.runs.reserve({
        id: createAgentRunId(),
        projectId: context.id,
        threadId: input.threadId,
        agentId: input.agent.id,
        triggerMessageId: input.triggerMessageId,
        modelId: input.agent.model.modelId,
        lease: freshLease(context.leaseMs),
      })
      return { kind: "run", run }
    } catch (error) {
      if (!(error instanceof AgentStorageError) || error.code !== "active_run_exists") {
        throw error
      }
      return this.takeOverActiveRun(context, input)
    }
  }

  private async takeOverActiveRun(
    context: AgentWorkerContext,
    input: { threadId: string; triggerMessageId: string }
  ): Promise<Reservation> {
    const { storage, id: projectId } = context
    const thread = await storage.threads.getById({ projectId, id: input.threadId })
    const activeRunId = thread?.activeRunId
    if (!activeRunId) {
      // The active run cleared between our reserve and this read; bounce briefly and try to win.
      return { kind: "held", availableAt: backoff(SHORT_BACKOFF_MS) }
    }

    const active = await storage.runs.getById({ projectId, id: activeRunId })
    if (!active) {
      return { kind: "held", availableAt: backoff(SHORT_BACKOFF_MS) }
    }
    if (active.status !== "running") {
      // Already terminal (late redelivery) — nothing to do.
      return { kind: "skip" }
    }
    if (active.triggerMessageId !== input.triggerMessageId) {
      // A different turn owns the thread (single-flight): wait for it to clear.
      return { kind: "held", availableAt: backoff(context.leaseMs) }
    }

    // Crash redelivery of our own run: take it over iff its lease has actually expired.
    try {
      const reclaimed = await storage.runs.reclaim({
        projectId,
        id: activeRunId,
        lease: freshLease(context.leaseMs),
      })
      return { kind: "run", run: reclaimed }
    } catch (error) {
      if (error instanceof AgentStorageError && error.code === "lease_not_expired") {
        return { kind: "held", availableAt: backoff(context.leaseMs) }
      }
      if (error instanceof AgentStorageError && error.code === "invalid_state") {
        return { kind: "skip" }
      }
      throw error
    }
  }

  private async finishQuietly(
    context: AgentWorkerContext,
    runId: string,
    leaseId: string,
    status: "failed" | "cancelled",
    error: unknown
  ): Promise<void> {
    try {
      await context.storage.runs.finish({
        projectId: context.id,
        id: runId,
        leaseId,
        status,
        error: toErrorMessage(error),
      })
    } catch {
      // Lease already lost or run already terminal — nothing to finalize.
    }
  }
}

function buildAgentContext(
  sixb: AgentWorkerSixb,
  options: AgentWorkerOptions,
  leaseMs: number
): AgentWorkerContext {
  const storage = sixb.storage.agents
  if (!storage) {
    throw new AgentWorkerError("Agent workers require storage.agents support.")
  }
  return {
    id: sixb.id,
    storage,
    tools: options.tools ?? {},
    streamSink: options.streamSink ?? NOOP_SINK,
    leaseMs,
    heartbeatMs: options.heartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3)),
    defaultMaxSteps: options.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
  }
}

function freshLease(leaseMs: number): AgentRunLease {
  return { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + leaseMs) }
}

function backoff(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
