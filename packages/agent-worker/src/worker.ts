import { join } from "node:path"
import type { AgentDefinition } from "@sixb/core"
import {
  createAgentRunExecutionToken,
  dispatchQueuedAgentRuns,
  MAIN_AGENT_ID,
  resolveAgentExecutionAuthorization,
  resolveInheritedMainAgentExecutionAuthorization,
  subscribeAgentRunCancel,
  workflowAgentNodeQueueJobId,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { createSixbError, isSixbError } from "@sixb/core/internal/errors"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { isAbortError, QueueDeliveryLeaseLostError, QueueWorker } from "@sixb/core/internal/workers"
import type { AgentQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import type { AgentRunExecution, AgentRunRecord } from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES, AgentStorageError } from "@sixb/core/storage"
import { loadAgentSkills } from "./agent-skills"
import { normalizeApiBaseUrl } from "./api-url"
import {
  type AgentContextBudget,
  type AgentModelContextLimits,
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  resolveAgentContextBudget,
} from "./context-budget"
import { prepareAgentConversationContext } from "./context-compaction"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  AgentTurnTimeoutError,
  AgentUsageRecordingError,
} from "./errors"
import { createAgentExecutionContext } from "./execution-context"
import { resolveAgentExecutionPlan } from "./execution-plan"
import { type AgentRunFailure, toAgentExecutionFailure, toAgentRunFailure } from "./failure"
import { finishRunOrThrow } from "./finalize"
import {
  enqueueAiModelCallRecovery,
  isPermanentAiUsageRecoveryError,
  recordRecoveredAiModelCall,
} from "./model-call-recovery"
import { DEFAULT_MAX_STEPS, runAgentTurn } from "./run-agent-turn"
import {
  type AgentExecutionEnvironment,
  createConversationAgentEnvironment,
} from "./run-environment"
import { createBrokerStreamSink, isolateStreamSink, withAgentActivityStream } from "./stream-sink"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type {
  AgentWorkerContext,
  AgentWorkerHost,
  AgentWorkerOptions,
  AgentWorkerStorage,
} from "./types"
import { enqueueWorkflowAgentNodeResume, executeWorkflowAgentNode } from "./workflow-node-execution"

const DEFAULT_AGENT_QUEUE_LEASE_MS = 60_000
const DEFAULT_AGENT_CONCURRENCY = 4
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const MAX_TIMER_DURATION_MS = 2_147_483_647
const AGENT_DISPATCH_POLL_MS = 1_000
/** Reconciliation is a safety net for failed request-time publication; an empty scan idles longer. */
const AGENT_DISPATCH_IDLE_MS = 10_000
const MAX_AGENT_DISPATCH_BACKOFF_MS = 30_000
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
const PRESTART_RETRY_BACKOFF_MS = 5_000
const AI_USAGE_RECOVERY_INITIAL_BACKOFF_MS = 5_000
const AI_USAGE_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000
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
export class AgentWorker extends QueueWorker<AgentQueueJob, typeof AGENT_RUN_FAILURE_CODES> {
  private readonly host: AgentWorkerHost
  private readonly agents: readonly AgentDefinition[]
  private readonly context: AgentWorkerContext | null
  private readonly idleWithoutAgents: boolean
  private contextBudgets: ReadonlyMap<string, AgentContextBudget> = new Map()
  /**
   * Sandbox teardowns that outlived their run's dispose() (boot still in flight when the turn
   * ended). stop() drains these so a graceful shutdown does not leave machines mid-teardown.
   */
  private readonly pendingTeardowns = new Set<Promise<void>>()

  constructor(host: AgentWorkerHost, options: AgentWorkerOptions) {
    const leaseMs = options.leaseMs ?? DEFAULT_AGENT_QUEUE_LEASE_MS
    const turnTimeoutMs = normalizeTurnTimeoutMs(options.turnTimeoutMs)
    super({
      projectId: host.id,
      queue: host.queues.agents,
      failureCodes: AGENT_RUN_FAILURE_CODES,
      workerId: `agent-worker-${host.id}`,
      claimLimit: options.concurrency ?? DEFAULT_AGENT_CONCURRENCY,
      leaseMs,
      idlePollMs: options.idlePollMs,
    })

    this.host = host
    this.agents = host.definitions.agents.list()
    this.idleWithoutAgents = this.agents.length === 0
    this.context = this.idleWithoutAgents ? null : buildAgentContext(host, options, turnTimeoutMs)
  }

  override async start(): Promise<void> {
    if (this.context) {
      const [modelsDev] = await Promise.all([
        import("./models-dev/catalog"),
        this.context.agentSkills,
      ])
      this.contextBudgets = resolveContextBudgets(
        this.agents,
        modelsDev.resolveModelsDevContextLimits
      )
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
    delivery: QueueDelivery<AgentQueueJob, (typeof AGENT_RUN_FAILURE_CODES)[number]>
  ): Promise<void> {
    const context = this.requireContext()
    const { job } = claimed
    if (job.type === "agent.ai-usage.record.requested") {
      await recordRecoveredAiModelCall(context.storage, job)
      return
    }
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
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Queued agent run '${runId}' was not found.`,
        { details: { runId } }
      )
    }
    if (queuedRun.status !== "queued" && queuedRun.status !== "running") {
      return
    }
    const agent = this.host.definitions.agents.getById(queuedRun.agentId)
    if (!agent) {
      const error = createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Unknown agent '${queuedRun.agentId}'.`,
        { details: agentRunFailureDetails(queuedRun) }
      )
      if (queuedRun.status === "queued") {
        const completedAt = new Date()
        const failure = toAgentRunFailure(
          createSixbError(
            "internal.unexpected",
            `[SixbAgentWorker] Agent '${queuedRun.agentId}' is not registered.`,
            { details: agentRunFailureDetails(queuedRun) }
          ),
          {
            status: "failed",
            at: completedAt,
            details: agentRunFailureDetails(queuedRun),
          }
        )
        const failed = await context.storage.agents.runs.finishQueued({
          projectId: context.id,
          id: queuedRun.id,
          status: "failed",
          error: failure,
          completedAt,
        })
        this.reportFailure(error, failed, job.attempt, failure)
        await context.streamSink.publishRunFinished(failed)
        return
      }
      throw error
    }
    const plan = resolveAgentExecutionPlan({
      agent,
      models: this.host.definitions.models?.language,
      defaultMaxSteps: context.defaultMaxSteps,
    })

    const durableExecution = await context.storage.executions.getById({
      projectId: context.id,
      id: queuedRun.executionId,
    })
    if (!durableExecution) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${runId}' references missing execution '${queuedRun.executionId}'.`,
        {
          details: {
            agentId: queuedRun.agentId,
            runId,
            executionId: queuedRun.executionId,
          },
        }
      )
    }
    const executionContext = await (async () => {
      // Transitional: run kind will replace the reserved id as the authority discriminator.
      if (agent.id === MAIN_AGENT_ID) {
        return createAgentExecutionContext({
          context,
          host: this.host,
          execution: durableExecution,
          agentId: agent.id,
          runId: queuedRun.id,
          authorization: await resolveInheritedMainAgentExecutionAuthorization({
            auth: context.storage.auth,
            projectId: context.id,
            authorizationRef: durableExecution.authorizationRef,
            security: this.host.definitions.security,
          }),
        })
      }

      const resolved = await resolveAgentExecutionAuthorization({
        auth: context.storage.auth,
        projectId: context.id,
        agentId: agent.id,
        authorizationRef: durableExecution.authorizationRef,
        security: this.host.definitions.security,
      })
      return createAgentExecutionContext({
        context,
        host: this.host,
        execution: durableExecution,
        agentId: agent.id,
        runId: queuedRun.id,
        authorization: { type: "principal", context: resolved.context },
        authorPrincipal: resolved.identity.principal,
      })
    })()

    const reservation = await this.startOrReclaim(context, {
      run: queuedRun,
      modelId: plan.model.modelId,
      execution: freshExecution(delivery.leaseExpiresAt),
    })
    if (reservation.kind === "skip") {
      return
    }
    const run = reservation.run
    const executionToken = run.execution?.token
    if (!executionToken) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${run.id}' has no execution token.`,
        { details: { agentId: run.agentId, runId: run.id } }
      )
    }
    let environment: AgentExecutionEnvironment | null = null
    let runtime: AgentTurnRuntime | null = null
    let stopOwnershipProjection: (() => void) | undefined
    // Watch for a user cancel (an out-of-band `/cancel` publishes to the run's control stream). Its
    // signal joins the turn's abort sources, so a cancel stops the model stream just like a shutdown.
    const cancel = await this.watchForCancel(run.id)
    const turnSignal = AbortSignal.any([signal, cancel.signal])

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
      runtime = createAgentTurnRuntime({
        context: executionContext,
        run,
        signal: turnSignal,
        providerOptions: plan.providerOptions,
      })
      const prepared = await prepareAgentConversationContext({
        context: executionContext,
        agent,
        budget: requiredContextBudget(this.contextBudgets, agent.id),
        run,
        runtime,
      })
      environment = await createConversationAgentEnvironment({
        context: executionContext,
        plan,
        run,
        signal: turnSignal,
        messages: prepared.threadContext.retainedMessages,
        skills: prepared.skills,
        onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
      })
      runtime.assertCanContinue()
      await runAgentTurn({
        context: environment.turnContext,
        plan,
        run,
        signal: turnSignal,
        runtime,
        threadContext: prepared.threadContext,
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
      const aborted =
        !(error instanceof AgentUsageRecordingError) &&
        (signal.aborted || cancel.signal.aborted || isAbortError(error))
      const finalized = await this.recordFate(
        context,
        run,
        executionToken,
        aborted ? "cancelled" : "failed",
        error
      )
      if (finalized) {
        if (finalized.run.status === "failed" && !(error instanceof AgentTurnTimeoutError)) {
          this.reportFailure(error, finalized.run, job.attempt, finalized.failure)
        }
        await context.streamSink.publishRunFinished(finalized.run)
      }
      // Shutdown abort: rethrow so `onAbortError` releases the job for another process. A user cancel
      // or a recorded model/tool failure keeps its fate on the record, so we ack by returning.
      if (signal.aborted) {
        throw error
      }
    } finally {
      stopOwnershipProjection?.()
      cancel.stop()
      runtime?.dispose()
      await environment?.dispose()
    }
  }

  protected override async onExecutionError(
    claimed: ClaimedQueueJob<AgentQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision> {
    if (claimed.job.type === "agent.ai-usage.record.requested") {
      return isPermanentAiUsageRecoveryError(error)
        ? { kind: "fail" }
        : {
            kind: "retry",
            availableAt: backoff(aiUsageRecoveryBackoffMs(claimed.job.attempt)),
          }
    }
    // We could not finalize the run (storage unavailable). Redeliver so a later delivery records the
    // fate — but cap the redeliveries so a persistent failure dead-letters instead of churning.
    if (error instanceof AgentFinalizationError) {
      if (claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS) {
        return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
      }
      return { kind: "fail" }
    }
    // Known deterministic failures honor the catalog policy; uncoded dependency failures retain
    // the worker's bounded pre-start retry path below.
    if (isSixbError(error) && !error.retryable) {
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
      const completedAt = new Date()
      const failure = toAgentRunFailure(error, {
        status: "failed",
        at: completedAt,
        details: agentRunFailureDetails(run),
      })
      const failed = await this.requireContext().storage.agents.runs.finishQueued({
        projectId: this.host.id,
        id: run.id,
        status: "failed",
        error: failure,
        completedAt,
      })
      this.reportFailure(error, failed, claimed.job.attempt, failure)
      await this.requireContext().streamSink.publishRunFinished(failed)
    }
    return { kind: "fail" }
  }

  protected override onAbortError(
    claimed: ClaimedQueueJob<AgentQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    if (claimed.job.type === "agent.ai-usage.record.requested") {
      return {
        kind: "retry",
        availableAt: backoff(aiUsageRecoveryBackoffMs(claimed.job.attempt)),
      }
    }
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
      throw createSixbError(
        "internal.unexpected",
        "[SixbAgentWorker] Agent worker has no agent storage configured."
      )
    }
    return this.context
  }

  private async startOrReclaim(
    context: AgentWorkerContext,
    input: {
      readonly run: AgentRunRecord
      readonly modelId: string
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
          modelId: input.modelId,
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

  private reportFailure(
    error: unknown,
    run: AgentRunRecord,
    attempt: number,
    failure: AgentRunFailure
  ): void {
    reportRunFailure(this.host, error, {
      projectId: this.host.id,
      attempt,
      runKind: "agent",
      run: {
        runId: run.id,
        agentId: run.agentId,
      },
      failure,
    })
  }

  private async recordFate(
    context: AgentWorkerContext,
    run: AgentRunRecord,
    executionToken: string,
    status: "failed" | "cancelled",
    error: unknown
  ): Promise<{ readonly run: AgentRunRecord; readonly failure: AgentRunFailure } | undefined> {
    try {
      const completedAt = new Date()
      const failure = toAgentExecutionFailure(error, {
        status,
        at: completedAt,
        details: {
          ...agentRunFailureDetails(run),
          ...(error instanceof AgentTurnTimeoutError ? { timeoutMs: String(error.timeoutMs) } : {}),
        },
      })
      const finalized = await finishRunOrThrow(context.storage.agents, {
        projectId: context.id,
        id: run.id,
        executionToken,
        status,
        error: failure,
        completedAt,
        ...(error instanceof AgentTurnTimeoutError ? { finishReason: "timeout" as const } : {}),
      })
      return { run: finalized, failure }
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

function resolveContextBudgets(
  agents: readonly AgentDefinition[],
  resolveModelContextLimits: (
    model: AgentDefinition["model"]
  ) => AgentModelContextLimits | undefined
): ReadonlyMap<string, AgentContextBudget> {
  const budgets = new Map<string, AgentContextBudget>()
  const warnedModels = new Set<string>()
  for (const agent of agents) {
    const modelLimits =
      agent.loop?.context?.windowTokens === undefined
        ? resolveModelContextLimits(agent.model)
        : undefined
    const budget = resolveAgentContextBudget(agent, modelLimits)
    budgets.set(agent.id, budget)
    if (budget.source !== "fallback") continue

    const model = `${agent.model.provider}/${agent.model.modelId}`
    if (warnedModels.has(model)) continue
    warnedModels.add(model)
    console.warn(
      `[SixbAgentWorker] Models.dev has no context limit for '${model}'; using the ${DEFAULT_CONTEXT_WINDOW_LABEL} fallback. Configure loop.context.windowTokens to override it.`
    )
  }
  return budgets
}

const DEFAULT_CONTEXT_WINDOW_LABEL = `${DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")}-token`

function requiredContextBudget(
  budgets: ReadonlyMap<string, AgentContextBudget>,
  agentId: string
): AgentContextBudget {
  const budget = budgets.get(agentId)
  if (!budget) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent '${agentId}' has no resolved context budget.`
    )
  }
  return budget
}

function buildAgentContext(
  host: AgentWorkerHost,
  options: AgentWorkerOptions,
  turnTimeoutMs: number
): AgentWorkerContext {
  const storage = host.storage
  assertAgentWorkerStorage(storage)
  if (!host.sandboxes) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require createSixb({ sandboxes }) for the built-in read and bash tools."
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
      withAgentActivityStream(
        options.streamSink ?? createBrokerStreamSink({ broker: host.broker, projectId: host.id }),
        host.broker
      )
    ),
    recoverAiModelCall: (input) => enqueueAiModelCallRecovery(host.queues.agents, input),
    agentSkills,
    defaultMaxSteps: options.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
    turnTimeoutMs,
  }
}

function assertAgentWorkerStorage(
  storage: AgentWorkerHost["storage"]
): asserts storage is AgentWorkerStorage {
  if (!storage.agents) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require storage.agents support."
    )
  }
  if (!storage.auth) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require storage.auth support."
    )
  }
  if (!storage.aiUsage) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require storage.aiUsage support."
    )
  }
  if (!storage.aiCosts) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require storage.aiCosts support."
    )
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

function aiUsageRecoveryBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10))
  return Math.min(
    AI_USAGE_RECOVERY_INITIAL_BACKOFF_MS * 2 ** exponent,
    AI_USAGE_RECOVERY_MAX_BACKOFF_MS
  )
}

function agentRunFailureDetails(
  run: Pick<AgentRunRecord, "id" | "agentId" | "threadId">
): Readonly<Record<string, string>> {
  return { agentId: run.agentId, runId: run.id, threadId: run.threadId }
}

function normalizeRequiredString(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require options.apiBaseUrl."
    )
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
function normalizeTurnTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TURN_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DURATION_MS) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent turn timeout must be a positive integer no greater than ${MAX_TIMER_DURATION_MS}ms.`
    )
  }
  return timeoutMs
}
