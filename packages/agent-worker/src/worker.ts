import { join } from "node:path"
import type {
  AgentDefinition,
  AgentRunExecution,
  AgentRunRecord,
  AgentRunRequestedQueueJob,
  ClaimedQueueJob,
  Principal,
  QueueDelivery,
  QueueWorkerFailureDecision,
} from "@sixb/core"
import {
  AgentStorageError,
  createAgentRunExecutionToken,
  isAbortError,
  QueueDeliveryLeaseLostError,
  QueueWorker,
  SYSTEM_PRINCIPAL,
  subscribeAgentRunCancel,
} from "@sixb/core"
import { loadAgentSkills } from "./agent-skills"
import { normalizeApiBaseUrl } from "./api-url"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  AgentLeaseHeldError,
  AgentWorkerError,
} from "./errors"
import { finishRunOrThrow } from "./finalize"
import { reconcileAgentExecutionIdentities, reconcileAgentExecutionIdentity } from "./identity"
import { DEFAULT_MAX_STEPS, runAgentTurn } from "./run-agent-turn"
import { type AgentRunEnvironment, createAgentRunEnvironment } from "./run-environment"
import { createBrokerStreamSink, isolateStreamSink } from "./stream-sink"
import type {
  AgentWorkerContext,
  AgentWorkerOptions,
  AgentWorkerSixb,
  AgentWorkerStorage,
} from "./types"

const DEFAULT_AGENT_QUEUE_LEASE_MS = 60_000
const DEFAULT_AGENT_CONCURRENCY = 4
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000
const SHORT_BACKOFF_MS = 250
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
/**
 * Cap on redeliveries for a run we cannot finalize. Beyond it the job is marked failed instead of
 * retrying forever; the run remains non-terminal until storage recovery or explicit repair.
 */
const MAX_FINALIZE_ATTEMPTS = 10

/** Outcome of trying to own a run for a claimed job. */
type Reservation =
  | { readonly kind: "run"; readonly run: AgentRunRecord }
  | { readonly kind: "held"; readonly availableAt: string }
  | { readonly kind: "skip" }

type QueuedRun = {
  readonly agent: AgentDefinition
  readonly threadId: string
  readonly runId: string
  readonly triggerMessageId: string
}

/**
 * Cohosted worker that turns `agent.run.requested` jobs into persisted agent runs.
 *
 * The queue delivery is the sole liveness authority. The worker reserves the run at claim time and
 * installs an execution token that fences durable writes. Queue redelivery rotates that token, so a
 * stale delivery cannot append or finalize after ownership moves. A run's terminal fate lives on its
 * record (like the action worker), so a
 * model/tool failure that we successfully record still acknowledges the job. The job is only left
 * for redelivery when we **cannot** record the fate (storage unavailable) — acking then would leave
 * the thread silently locked forever, since nothing else reclaims a run but a redelivered job.
 */
export class AgentWorker extends QueueWorker<AgentRunRequestedQueueJob> {
  private readonly sixb: AgentWorkerSixb
  private readonly context: AgentWorkerContext | null
  private readonly idleWithoutAgents: boolean
  /**
   * Sandbox teardowns that outlived their run's dispose() (boot still in flight when the turn
   * ended). stop() drains these so a graceful shutdown does not leave machines mid-teardown.
   */
  private readonly pendingTeardowns = new Set<Promise<void>>()

  constructor(sixb: AgentWorkerSixb, options: AgentWorkerOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_AGENT_QUEUE_LEASE_MS
    super({
      projectId: sixb.id,
      queue: sixb.queues.agents,
      workerId: `agent-worker-${sixb.id}`,
      claimLimit: normalizeConcurrency(options.concurrency),
      leaseMs,
      idlePollMs: options.idlePollMs,
    })

    this.sixb = sixb
    this.idleWithoutAgents = sixb.agents.list().length === 0
    this.context = this.idleWithoutAgents ? null : buildAgentContext(sixb, options)
  }

  override async start(): Promise<void> {
    if (this.context) {
      await this.context.agentSkills
    }
    await super.start()
  }

  protected override async run(signal: AbortSignal): Promise<void> {
    if (!this.idleWithoutAgents) {
      await reconcileAgentExecutionIdentities(
        this.requireContext().storage,
        this.sixb.id,
        this.sixb.agents.list()
      )
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

  override async stop(): Promise<void> {
    // super.stop() awaits every in-flight execute() (and thus its dispose()); draining afterwards
    // catches the detached teardowns dispose() left running so we never report stopped while a
    // sandbox machine is still being reaped.
    await super.stop()
    await Promise.allSettled([...this.pendingTeardowns])
  }

  /** Register a detached sandbox teardown so stop() can drain it; self-removes when it settles. */
  private trackTeardown(teardown: Promise<void>): void {
    this.pendingTeardowns.add(teardown)
    void teardown.finally(() => this.pendingTeardowns.delete(teardown))
  }

  protected async execute(
    claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<AgentRunRequestedQueueJob>
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    if (job.type !== "agent.run.requested") {
      throw new AgentWorkerError(`Unsupported agent job type '${job.type}'.`)
    }

    const { agentId, threadId, runId, triggerMessageId } = job.payload
    const agent = this.sixb.agents.getById(agentId)
    if (!agent) {
      throw new AgentWorkerError(`Unknown agent '${agentId}'.`)
    }
    const identity = await reconcileAgentExecutionIdentity(context.storage, context.id, agent)

    const reservation = await this.reserveOrReclaim(context, {
      agent,
      threadId,
      runId,
      triggerMessageId,
      requestedByPrincipal: job.payload.requestedByPrincipal ?? SYSTEM_PRINCIPAL,
      executionPrincipal: identity.principal,
      execution: freshExecution(delivery.leaseExpiresAt),
    })
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
    const executionToken = run.execution?.token
    if (!executionToken) {
      throw new AgentWorkerError(`Agent run '${run.id}' has no execution token.`)
    }

    let environment: AgentRunEnvironment | null = null
    let stopOwnershipProjection: (() => void) | undefined
    // Watch for a user cancel (an out-of-band `/cancel` publishes to the run's control stream). Its
    // signal joins the turn's abort sources, so a cancel stops the model stream just like a shutdown.
    const cancel = await this.watchForCancel(run.id)

    try {
      // Persist the queue's latest confirmed expiration for API-gateway authorization without
      // introducing another heartbeat or ownership clock.
      stopOwnershipProjection = delivery.onLeaseRenewed((renewed) => {
        void this.confirmExecutionOwnership(
          context,
          run.id,
          executionToken,
          renewed.leaseExpiresAt
        ).catch((error) => {
          if (!isExecutionGone(error)) {
            console.error(
              `[SixbAgentWorker] Could not project queue ownership for agent run '${run.id}'.`,
              error
            )
          }
        })
      })
      await this.confirmExecutionOwnership(context, run.id, executionToken, delivery.leaseExpiresAt)

      await context.streamSink.publishStarted(run)
      environment = await createAgentRunEnvironment({
        context,
        agent,
        run,
        onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
      })
      await runAgentTurn({
        context: environment.turnContext,
        agent,
        run,
        signal: AbortSignal.any([signal, cancel.signal]),
      })
    } catch (error) {
      // Queue ownership or the durable execution token was lost. Touch nothing; the current queue
      // owner will reclaim the run with a fresh token.
      if (
        error instanceof AgentExecutionLostError ||
        error instanceof QueueDeliveryLeaseLostError ||
        signal.reason instanceof QueueDeliveryLeaseLostError
      ) {
        return
      }
      // The turn succeeded but its finalize could not be recorded (storage down). Don't ack: let the
      // job redeliver so a later delivery finalizes the run — onExecutionError turns this into retry.
      if (error instanceof AgentFinalizationError) {
        throw error
      }
      // Otherwise record the run's terminal fate. `recordFate` retries transient blips; if it cannot
      // record the fate at all it raises `AgentFinalizationError`, which propagates here so the job
      // is redelivered rather than acked with the thread left silently locked. A user cancel is
      // detected off its own signal so it records `cancelled` however the aborted stream surfaced.
      const aborted = signal.aborted || cancel.signal.aborted || isAbortError(error)
      const finalized = await this.recordFate(
        context,
        run.id,
        executionToken,
        aborted ? "cancelled" : "failed",
        error
      )
      if (finalized) {
        await context.streamSink.publishRunFinished(finalized)
      }
      // Shutdown abort: rethrow so `onAbortError` releases the job for another process. A user cancel
      // or a recorded model/tool failure keeps its fate on the record, so we ack by returning.
      if (signal.aborted) {
        throw error
      }
    } finally {
      stopOwnershipProjection?.()
      cancel.stop()
      await environment?.dispose()
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
    input: {
      agent: AgentDefinition
      threadId: string
      runId: string
      triggerMessageId: string
      requestedByPrincipal: Principal
      executionPrincipal: Extract<Principal, { readonly type: "serviceAccount" }>
      execution: AgentRunExecution
    }
  ): Promise<Reservation> {
    try {
      const run = await context.storage.agents.runs.reserve({
        id: input.runId,
        projectId: context.id,
        threadId: input.threadId,
        agentId: input.agent.id,
        triggerMessageId: input.triggerMessageId,
        requestedByPrincipal: input.requestedByPrincipal,
        executionPrincipal: input.executionPrincipal,
        modelId: input.agent.model.modelId,
        execution: input.execution,
      })
      return { kind: "run", run }
    } catch (error) {
      if (!(error instanceof AgentStorageError)) {
        throw error
      }
      if (error.code === "active_run_exists") {
        const thread = await context.storage.agents.threads.getById({
          projectId: context.id,
          id: input.threadId,
        })
        const activeRunId = thread?.activeRunId
        if (!activeRunId) {
          // The active run cleared between our reserve and this read; bounce briefly and try to win.
          return { kind: "held", availableAt: backoff(SHORT_BACKOFF_MS) }
        }
        if (activeRunId !== input.runId) {
          // A different turn owns the thread (single-flight): wait for it to clear.
          return { kind: "held", availableAt: backoff(this.config.leaseMs) }
        }
        return this.reclaimOrSkipQueuedRun(context, input)
      }
      if (error.code === "duplicate_id") {
        return this.reclaimOrSkipQueuedRun(context, input)
      }
      throw error
    }
  }

  private async reclaimOrSkipQueuedRun(
    context: AgentWorkerContext,
    input: QueuedRun & { readonly execution: AgentRunExecution }
  ): Promise<Reservation> {
    const run = await context.storage.agents.runs.getById({
      projectId: context.id,
      id: input.runId,
    })
    if (!run) {
      return { kind: "held", availableAt: backoff(SHORT_BACKOFF_MS) }
    }
    if (
      run.id !== input.runId ||
      run.threadId !== input.threadId ||
      run.agentId !== input.agent.id ||
      run.triggerMessageId !== input.triggerMessageId
    ) {
      throw new AgentWorkerError(`Agent run '${input.runId}' does not match its queued request.`)
    }
    if (run.status !== "running") {
      return { kind: "skip" }
    }
    try {
      const reclaimed = await context.storage.agents.runs.reclaim({
        projectId: context.id,
        id: input.runId,
        execution: input.execution,
      })
      return { kind: "run", run: reclaimed }
    } catch (error) {
      if (error instanceof AgentStorageError && error.code === "invalid_state") {
        return { kind: "skip" }
      }
      throw error
    }
  }

  /**
   * Subscribe to a run's cancel signal for the duration of its turn. Failing to attach the watch
   * only costs cancellability for this run (it still runs to completion), so it is best-effort and
   * never fails the turn. The returned `stop` unsubscribes.
   */
  private async watchForCancel(runId: string): Promise<{
    readonly signal: AbortSignal
    readonly stop: () => void
  }> {
    const controller = new AbortController()
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = await subscribeAgentRunCancel(
        this.sixb.broker,
        { projectId: this.sixb.id, runId },
        () => controller.abort()
      )
    } catch (error) {
      console.error(`[SixbAgentWorker] Agent run '${runId}' cancel watch failed to start:`, error)
    }
    return { signal: controller.signal, stop: () => unsubscribe?.() }
  }

  private confirmExecutionOwnership(
    context: AgentWorkerContext,
    runId: string,
    executionToken: string,
    queueLeaseExpiresAt: string
  ): Promise<AgentRunRecord> {
    return context.storage.agents.runs.confirmExecutionOwnership({
      projectId: context.id,
      id: runId,
      executionToken,
      queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
    })
  }

  private async recordFate(
    context: AgentWorkerContext,
    runId: string,
    executionToken: string,
    status: "failed" | "cancelled",
    error: unknown
  ): Promise<AgentRunRecord | undefined> {
    try {
      return await finishRunOrThrow(context.storage.agents, {
        projectId: context.id,
        id: runId,
        executionToken,
        status,
        error: toErrorMessage(error),
      })
    } catch (finalizeError) {
      // Execution already lost / run already terminal — nothing more to record.
      if (finalizeError instanceof AgentExecutionLostError) {
        return undefined
      }
      // Storage stayed unavailable across retries: propagate so the job is redelivered, not acked.
      throw finalizeError
    }
  }
}

function buildAgentContext(sixb: AgentWorkerSixb, options: AgentWorkerOptions): AgentWorkerContext {
  const storage = sixb.storage
  if (!storage.agents) {
    throw new AgentWorkerError("Agent workers require storage.agents support.")
  }
  if (!storage.auth) {
    throw new AgentWorkerError("Agent workers require storage.auth support.")
  }
  if (!sixb.sandboxes) {
    throw new AgentWorkerError(
      "Agent workers require createSixb({ sandboxes }) for the built-in bash tool."
    )
  }
  const agentSkills = loadAgentSkills({
    projectSkillsDir:
      options.skillsDir === undefined
        ? join(sixb.projectRoot ?? process.cwd(), "skills")
        : options.skillsDir,
  })
  agentSkills.catch(() => {})

  return {
    id: sixb.id,
    storage: storage as AgentWorkerStorage,
    blobStorage: sixb.blobStorage,
    sandboxes: sixb.sandboxes,
    baseTools: options.tools ?? {},
    // Normalize the server base URL once here, at the boundary. Everything downstream (the gateway
    // URL builder, the sandbox run context) consumes it verbatim.
    apiBaseUrl: normalizeApiBaseUrl(normalizeRequiredString(options.apiBaseUrl)),
    streamSink: isolateStreamSink(
      options.streamSink ?? createBrokerStreamSink({ broker: sixb.broker, projectId: sixb.id })
    ),
    agentSkills,
    defaultMaxSteps: options.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
    turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  }
}

function freshExecution(queueLeaseExpiresAt: string): AgentRunExecution {
  return {
    token: createAgentRunExecutionToken(),
    queueLeaseExpiresAt: new Date(queueLeaseExpiresAt),
  }
}

function isExecutionGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "execution_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
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

function normalizeRequiredString(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw new AgentWorkerError("Agent workers require options.apiBaseUrl.")
  }
  return trimmed
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_AGENT_CONCURRENCY
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new AgentWorkerError("Agent worker concurrency must be at least 1.")
  }
  return Math.floor(value)
}
