import { join } from "node:path"
import type { AgentDefinition, Principal } from "@sixb/core"
import {
  createAgentRunExecutionToken,
  dispatchQueuedAgentRuns,
  subscribeAgentRunCancel,
} from "@sixb/core/internal/agents"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { isAbortError, QueueDeliveryLeaseLostError, QueueWorker } from "@sixb/core/internal/workers"
import type { AgentRunRequestedQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import type { AgentRunExecution, AgentRunRecord } from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { loadAgentSkills } from "./agent-skills"
import { normalizeApiBaseUrl } from "./api-url"
import { AgentExecutionLostError, AgentFinalizationError, AgentWorkerError } from "./errors"
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
const AGENT_DISPATCH_POLL_MS = 1_000
/** Reconciliation is a safety net for failed request-time publication; an empty scan idles longer. */
const AGENT_DISPATCH_IDLE_MS = 10_000
const MAX_AGENT_DISPATCH_BACKOFF_MS = 30_000
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
const PRESTART_RETRY_BACKOFF_MS = 5_000
/** Cap retries for persistent setup or finalization failures so jobs cannot churn forever. */
const MAX_AGENT_DELIVERY_ATTEMPTS = 10

/** Outcome of trying to own a run for a claimed job. */
type Reservation =
  | { readonly kind: "run"; readonly run: AgentRunRecord }
  | { readonly kind: "skip" }

type QueuedRun = {
  readonly agent: AgentDefinition
  readonly threadId: string
  readonly runId: string
  readonly triggerMessageId: string
}

/**
 * Cohosted worker that turns durable queued agent runs into executing turns.
 *
 * The queue delivery owns liveness and redelivery. Each claim installs a fresh execution token on
 * the durable run; storage checks that token to fence late writes from stale deliveries. A run's
 * terminal fate lives on its record (like the action worker), so a
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
      const context = this.requireContext()
      await reconcileAgentExecutionIdentities(
        context.storage,
        this.sixb.id,
        this.sixb.agents.list()
      )

      const stopDispatch = new AbortController()
      const workerSignal = AbortSignal.any([signal, stopDispatch.signal])
      const dispatchLoop = this.runDispatchLoop(context, workerSignal)
      try {
        await super.run(workerSignal)
      } finally {
        stopDispatch.abort()
        await dispatchLoop
      }
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
      const run = await context.storage.agents.runs.getById({ projectId: context.id, id: runId })
      if (
        run?.status === "queued" &&
        run.agentId === agentId &&
        run.threadId === threadId &&
        run.triggerMessageId === triggerMessageId
      ) {
        const failed = await context.storage.agents.runs.finishQueued({
          projectId: context.id,
          id: run.id,
          status: "failed",
          error: `Agent '${agentId}' is not registered.`,
        })
        await context.streamSink.publishRunFinished(failed)
        return
      }
      throw new AgentWorkerError(`Unknown agent '${agentId}'.`)
    }
    const identity = await reconcileAgentExecutionIdentity(context.storage, context.id, agent)

    const reservation = await this.startOrReclaim(context, {
      agent,
      threadId,
      runId,
      triggerMessageId,
      executionPrincipal: identity.principal,
      execution: freshExecution(delivery.leaseExpiresAt),
    })
    if (reservation.kind === "skip") {
      return
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
      // The queue remains the sole source of ownership timing. Persist its latest confirmed
      // expiration so the API gateway can fail closed without maintaining another heartbeat.
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
      // Catch a renewal that completed between starting/reclaiming the run and attaching the
      // observer. Storage keeps this projection monotonic, so racing confirmations are safe.
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
      // Queue ownership or the durable execution token was lost. Touch nothing; the current
      // delivery will reconcile the run.
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

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<AgentRunRequestedQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    // We could not finalize the run (storage unavailable). Redeliver so a later delivery records the
    // fate — but cap the redeliveries so a persistent failure dead-letters instead of churning.
    if (error instanceof AgentFinalizationError) {
      if (claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS) {
        return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
      }
      return { kind: "fail" }
    }
    if (error instanceof AgentWorkerError) {
      return { kind: "fail" }
    }

    // Storage/identity setup failed before queued→running. Keep the deterministic queue job alive;
    // if the dependency never recovers, record a visible pre-stream failure before dead-lettering.
    if (claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS) {
      return { kind: "retry", availableAt: backoff(PRESTART_RETRY_BACKOFF_MS) }
    }
    const { agentId, threadId, runId, triggerMessageId } = claimed.job.payload
    const run = await this.requireContext().storage.agents.runs.getById({
      projectId: this.sixb.id,
      id: runId,
    })
    if (
      run?.status === "queued" &&
      run.agentId === agentId &&
      run.threadId === threadId &&
      run.triggerMessageId === triggerMessageId
    ) {
      const failed = await this.requireContext().storage.agents.runs.finishQueued({
        projectId: this.sixb.id,
        id: run.id,
        status: "failed",
        error: toErrorMessage(error),
      })
      await this.requireContext().streamSink.publishRunFinished(failed)
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

  /** Re-publish queued runs until their deterministic queue jobs are accepted. */
  private async runDispatchLoop(context: AgentWorkerContext, signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0

    while (!signal.aborted) {
      let dispatched = 0
      try {
        const result = await dispatchQueuedAgentRuns({
          projectId: context.id,
          storage: context.storage.agents,
          queue: this.sixb.queues.agents,
        })
        dispatched = result.dispatched.length
        if (result.failures.length === 0) {
          consecutiveFailures = 0
        } else {
          consecutiveFailures += 1
          console.error(
            `[SixbAgentWorker] Could not dispatch ${result.failures.length} queued agent run(s); retrying.`,
            result.failures[0]?.error
          )
        }
      } catch (error) {
        consecutiveFailures += 1
        console.error("[SixbAgentWorker] Could not scan queued agent runs; retrying.", error)
      }

      const delayMs =
        consecutiveFailures > 0
          ? Math.min(
              AGENT_DISPATCH_POLL_MS * 2 ** (consecutiveFailures - 1),
              MAX_AGENT_DISPATCH_BACKOFF_MS
            )
          : dispatched > 0
            ? AGENT_DISPATCH_POLL_MS
            : AGENT_DISPATCH_IDLE_MS
      await waitForAbort(delayMs, signal)
    }
  }

  private requireContext(): AgentWorkerContext {
    if (!this.context) {
      throw new AgentWorkerError("Agent worker has no agent storage configured.")
    }
    return this.context
  }

  private async startOrReclaim(
    context: AgentWorkerContext,
    input: QueuedRun & {
      executionPrincipal: Extract<Principal, { readonly type: "serviceAccount" }>
      execution: AgentRunExecution
    }
  ): Promise<Reservation> {
    const run = await context.storage.agents.runs.getById({
      projectId: context.id,
      id: input.runId,
    })
    if (!run) {
      throw new AgentWorkerError(`Queued agent run '${input.runId}' was not found.`)
    }
    if (
      run.threadId !== input.threadId ||
      run.agentId !== input.agent.id ||
      run.triggerMessageId !== input.triggerMessageId
    ) {
      throw new AgentWorkerError(`Agent run '${input.runId}' does not match its queued request.`)
    }
    if (run.status === "queued") {
      return {
        kind: "run",
        run: await context.storage.agents.runs.start({
          projectId: context.id,
          id: input.runId,
          executionPrincipal: input.executionPrincipal,
          modelId: input.agent.model.modelId,
          execution: input.execution,
        }),
      }
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

async function waitForAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
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
