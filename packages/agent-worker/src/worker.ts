import type {
  AgentDefinition,
  AgentRunLease,
  AgentRunRecord,
  AgentRunRequestedQueueJob,
  ClaimedQueueJob,
  QueueWorkerFailureDecision,
} from "@sixb/core"
import {
  AgentStorageError,
  createAgentRunId,
  createAgentRunLeaseId,
  isAbortError,
  QueueWorker,
} from "@sixb/core"
import {
  AgentFinalizationError,
  AgentLeaseHeldError,
  AgentLeaseLostError,
  AgentWorkerError,
} from "./errors"
import { finishRunOrThrow } from "./finalize"
import { DEFAULT_MAX_STEPS, runAgentTurn } from "./run-agent-turn"
import type { AgentWorkerContext, AgentWorkerOptions, AgentWorkerSixb, StreamSink } from "./types"

const DEFAULT_AGENT_LEASE_MS = 60_000
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000
const SHORT_BACKOFF_MS = 250
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
/**
 * Cap on redeliveries for a run we cannot finalize. Beyond it the job dead-letters (visibly) instead
 * of churning forever; the still-`running` run awaits storage recovery + a reaper (a later slice).
 */
const MAX_FINALIZE_ATTEMPTS = 10
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
 * write on the lease id. A run's terminal fate lives on its record (like the action worker), so a
 * model/tool failure that we successfully record still acknowledges the job. The job is only left
 * for redelivery when we **cannot** record the fate (storage unavailable) — acking then would leave
 * the thread silently locked forever, since nothing else reclaims a run but a redelivered job.
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
    const leaseId = run.lease?.id

    try {
      await runAgentTurn({ context, agent, run, signal })
    } catch (error) {
      // The run was reclaimed out from under us; this delivery is a duplicate. Ack, touch nothing.
      if (error instanceof AgentLeaseLostError) {
        return
      }
      // The turn succeeded but its finalize could not be recorded (storage down). Don't ack: let the
      // job redeliver so a later delivery finalizes the run — onExecutionError turns this into retry.
      if (error instanceof AgentFinalizationError) {
        throw error
      }
      if (!leaseId) {
        throw error
      }
      // Otherwise record the run's terminal fate. `recordFate` retries transient blips; if it cannot
      // record the fate at all it raises `AgentFinalizationError`, which propagates here so the job
      // is redelivered rather than acked with the thread left silently locked.
      const aborted = signal.aborted || isAbortError(error)
      await this.recordFate(context, run.id, leaseId, aborted ? "cancelled" : "failed", error)
      // Shutdown abort: rethrow so `onAbortError` fails the job (the run is already `cancelled`).
      // Model/tool failure or turn timeout: fate is on the record, so we ack by returning.
      if (aborted) {
        throw error
      }
    }
  }

  protected override onExecutionError(
    claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    if (error instanceof AgentLeaseHeldError) {
      return { kind: "retry", availableAt: error.availableAt }
    }
    // We could not finalize the run (storage unavailable). Redeliver so a later delivery records the
    // fate — but cap the redeliveries so a persistent failure dead-letters instead of churning.
    if (error instanceof AgentFinalizationError) {
      if (claimed.job.attempt < MAX_FINALIZE_ATTEMPTS) {
        return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
      }
      return { kind: "fail" }
    }
    return { kind: "fail" }
  }

  protected override onAbortError(
    _claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    // Shutdown reached us before we could record the run's fate: redeliver so another process
    // finalizes it. Otherwise the run is already terminal, so fail (no redelivery needed).
    if (error instanceof AgentFinalizationError) {
      return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
    }
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

  private async recordFate(
    context: AgentWorkerContext,
    runId: string,
    leaseId: string,
    status: "failed" | "cancelled",
    error: unknown
  ): Promise<void> {
    try {
      await finishRunOrThrow(
        context.storage,
        { projectId: context.id, id: runId, leaseId, status, error: toErrorMessage(error) },
        runId
      )
    } catch (finalizeError) {
      // Lease already lost / run already terminal — nothing more to record, the delivery is acked.
      if (finalizeError instanceof AgentLeaseLostError) {
        return
      }
      // Storage stayed unavailable across retries: propagate so the job is redelivered, not acked.
      throw finalizeError
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
    turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  }
}

function freshLease(leaseMs: number): AgentRunLease {
  return { id: createAgentRunLeaseId(), expiresAt: new Date(Date.now() + leaseMs) }
}

function backoff(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
