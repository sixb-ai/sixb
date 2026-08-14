import { join } from "node:path"
import type { AgentDefinition } from "@sixb/core"
import {
  createAgentRunExecutionToken,
  dispatchQueuedAgentRuns,
  resolveAgentExecutionAuthorization,
  subscribeAgentRunCancel,
  workflowAgentNodeQueueJobId,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { isAbortError, QueueDeliveryLeaseLostError, QueueWorker } from "@sixb/core/internal/workers"
import type { AgentQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import type { AgentRunExecution, AgentRunRecord } from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { loadAgentSkills } from "./agent-skills"
import { normalizeApiBaseUrl } from "./api-url"
import { AgentExecutionLostError, AgentFinalizationError, AgentWorkerError } from "./errors"
import { createAgentExecutionContext } from "./execution-context"
import { finishRunOrThrow } from "./finalize"
import { DEFAULT_MAX_STEPS, runAgentTurn } from "./run-agent-turn"
import {
  type AgentExecutionEnvironment,
  createConversationAgentEnvironment,
} from "./run-environment"
import { createBrokerStreamSink, isolateStreamSink } from "./stream-sink"
import type {
  AgentWorkerContext,
  AgentWorkerHost,
  AgentWorkerOptions,
  AgentWorkerStorage,
} from "./types"
import { enqueueWorkflowAgentNodeResume, executeWorkflowAgentNode } from "./workflow-node-execution"

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
export class AgentWorker extends QueueWorker<AgentQueueJob> {
  private readonly host: AgentWorkerHost
  private readonly context: AgentWorkerContext | null
  private readonly idleWithoutAgents: boolean
  /**
   * Sandbox teardowns that outlived their run's dispose() (boot still in flight when the turn
   * ended). stop() drains these so a graceful shutdown does not leave machines mid-teardown.
   */
  private readonly pendingTeardowns = new Set<Promise<void>>()

  constructor(host: AgentWorkerHost, options: AgentWorkerOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_AGENT_QUEUE_LEASE_MS
    super({
      projectId: host.id,
      queue: host.queues.agents,
      workerId: `agent-worker-${host.id}`,
      claimLimit: normalizeConcurrency(options.concurrency),
      leaseMs,
      idlePollMs: options.idlePollMs,
    })

    this.host = host
    this.idleWithoutAgents = host.definitions.agents.list().length === 0
    this.context = this.idleWithoutAgents ? null : buildAgentContext(host, options)
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
    claimed: ClaimedQueueJob<AgentQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<AgentQueueJob>
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    if (job.type === "agent.workflow-node.requested") {
      await executeWorkflowAgentNode({
        context,
        host: this.host,
        job,
        signal,
        delivery,
        watchForCancel: (runId) => this.watchForCancel(runId),
        onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
      })
      return
    }
    const { runId } = job.payload
    const queuedRun = await context.storage.agents.runs.getById({
      projectId: context.id,
      id: runId,
    })
    if (!queuedRun) {
      throw new AgentWorkerError(`Queued agent run '${runId}' was not found.`)
    }
    if (queuedRun.status !== "queued" && queuedRun.status !== "running") {
      return
    }
    const agent = this.host.definitions.agents.getById(queuedRun.agentId)
    if (!agent) {
      const error = new AgentWorkerError(`Unknown agent '${queuedRun.agentId}'.`)
      if (queuedRun.status === "queued") {
        const failed = await context.storage.agents.runs.finishQueued({
          projectId: context.id,
          id: queuedRun.id,
          status: "failed",
          error: `Agent '${queuedRun.agentId}' is not registered.`,
        })
        this.reportFailure(error, failed, job.attempt)
        await context.streamSink.publishRunFinished(failed)
        return
      }
      throw error
    }

    const durableExecution = await context.storage.executions.getById({
      projectId: context.id,
      id: queuedRun.executionId,
    })
    if (!durableExecution) {
      throw new AgentWorkerError(
        `Agent run '${runId}' references missing execution '${queuedRun.executionId}'.`
      )
    }
    const resolved = await resolveAgentExecutionAuthorization({
      auth: context.storage.auth,
      projectId: context.id,
      agentId: agent.id,
      authorizationRef: durableExecution.authorizationRef,
      security: this.host.definitions.security,
    })
    const executionContext = createAgentExecutionContext({
      context,
      host: this.host,
      execution: durableExecution,
      agentId: agent.id,
      runId: queuedRun.id,
      authorization: resolved.context,
      agentPrincipal: resolved.identity.principal,
    })

    const reservation = await this.startOrReclaim(context, {
      run: queuedRun,
      agent,
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
    let environment: AgentExecutionEnvironment | null = null
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
      environment = await createConversationAgentEnvironment({
        context: executionContext,
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
        if (finalized.status === "failed") {
          this.reportFailure(error, finalized, job.attempt)
        }
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
    claimed: ClaimedQueueJob<AgentQueueJob>,
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
    if (claimed.job.type !== "agent.run.requested") {
      return claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS
        ? { kind: "retry", availableAt: backoff(PRESTART_RETRY_BACKOFF_MS) }
        : { kind: "fail" }
    }
    const { runId } = claimed.job.payload
    const run = await this.requireContext().storage.agents.runs.getById({
      projectId: this.host.id,
      id: runId,
    })
    if (run?.status === "queued") {
      const failed = await this.requireContext().storage.agents.runs.finishQueued({
        projectId: this.host.id,
        id: run.id,
        status: "failed",
        error: toErrorMessage(error),
      })
      this.reportFailure(error, failed, claimed.job.attempt)
      await this.requireContext().streamSink.publishRunFinished(failed)
    }
    return { kind: "fail" }
  }

  protected override onAbortError(
    claimed: ClaimedQueueJob<AgentQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    if (claimed.job.type === "agent.workflow-node.requested") {
      return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
    }
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
          queue: this.host.queues.agents,
        })
        dispatched = result.dispatched.length
        dispatched += await this.dispatchWorkflowAgentNodes(context)
        dispatched += await this.dispatchWorkflowResumes(context)
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

  private async dispatchWorkflowAgentNodes(context: AgentWorkerContext): Promise<number> {
    const workflowRuns = context.storage.workflowRuns
    if (!workflowRuns) return 0
    const queued = await workflowRuns.agentNodes.list({
      projectId: context.id,
      statuses: ["queued"],
      order: "asc",
      limit: 100,
    })
    if (queued.runs.length === 0) return 0
    await this.host.queues.agents.enqueue({
      projectId: context.id,
      jobs: queued.runs.map((run) => ({
        id: workflowAgentNodeQueueJobId(run.nodeRunId),
        type: "agent.workflow-node.requested" as const,
        payload: { nodeRunId: run.nodeRunId },
      })),
    })
    return queued.runs.length
  }

  private async dispatchWorkflowResumes(context: AgentWorkerContext): Promise<number> {
    const workflowRuns = context.storage.workflowRuns
    if (!workflowRuns) return 0
    const completed = await workflowRuns.agentNodes.list({
      projectId: context.id,
      statuses: ["succeeded"],
      order: "asc",
      limit: 100,
    })
    let dispatched = 0
    for (const execution of completed.runs) {
      const node = await workflowRuns.nodes.getById({
        projectId: context.id,
        id: execution.nodeRunId,
      })
      if (!node) continue
      const run = await workflowRuns.getById({ projectId: context.id, id: node.workflowRunId })
      if (run?.status !== "waiting") continue
      await enqueueWorkflowAgentNodeResume(this.host, node)
      dispatched += 1
    }
    return dispatched
  }

  private requireContext(): AgentWorkerContext {
    if (!this.context) {
      throw new AgentWorkerError("Agent worker has no agent storage configured.")
    }
    return this.context
  }

  private async startOrReclaim(
    context: AgentWorkerContext,
    input: {
      readonly run: AgentRunRecord
      readonly agent: AgentDefinition
      readonly execution: AgentRunExecution
    }
  ): Promise<Reservation> {
    const { run } = input
    if (run.status === "queued") {
      return {
        kind: "run",
        run: await context.storage.agents.runs.start({
          projectId: context.id,
          id: run.id,
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
        id: run.id,
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
        this.host.broker,
        { projectId: this.host.id, runId },
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

  private reportFailure(error: unknown, run: AgentRunRecord, attempt: number): void {
    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      occurredAt: run.completedAt,
      attempt,
      run: {
        kind: "agent",
        runId: run.id,
        agentId: run.agentId,
      },
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

function buildAgentContext(host: AgentWorkerHost, options: AgentWorkerOptions): AgentWorkerContext {
  const storage = host.storage
  assertAgentWorkerStorage(storage)
  if (!host.sandboxes) {
    throw new AgentWorkerError(
      "Agent workers require createSixb({ sandboxes }) for the built-in bash tool."
    )
  }
  const agentSkills = loadAgentSkills({
    projectSkillsDir:
      options.skillsDir === undefined
        ? join(host.projectRoot ?? process.cwd(), "skills")
        : options.skillsDir,
  })
  agentSkills.catch(() => {})

  return {
    id: host.id,
    storage,
    sandboxes: host.sandboxes,
    logging: host.logging,
    valueTypesById: host.definitions.ontology.getValueTypesById(),
    // Normalize the server base URL once here, at the boundary. Everything downstream (the gateway
    // URL builder, the sandbox run context) consumes it verbatim.
    apiBaseUrl: normalizeApiBaseUrl(normalizeRequiredString(options.apiBaseUrl)),
    streamSink: isolateStreamSink(
      options.streamSink ?? createBrokerStreamSink({ broker: host.broker, projectId: host.id })
    ),
    agentSkills,
    defaultMaxSteps: options.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
    turnTimeoutMs: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  }
}

function assertAgentWorkerStorage(
  storage: AgentWorkerHost["storage"]
): asserts storage is AgentWorkerStorage {
  if (!storage.agents) {
    throw new AgentWorkerError("Agent workers require storage.agents support.")
  }
  if (!storage.auth) {
    throw new AgentWorkerError("Agent workers require storage.auth support.")
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
