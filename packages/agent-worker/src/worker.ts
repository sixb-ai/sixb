import {
  type AgentExecutionContext,
  type AgentRunFailure,
  type AgentRunSettings,
  agentRunFailureDetails,
  runConversationTurn,
  toAgentRunFailure,
} from "@sixb/agent"
import { bindDurableAgentExecution } from "@sixb/core/internal/agent-execution"
import {
  AgentFinalizationError,
  type AgentRunSession,
  type AgentRunSessionHost,
  afterAgentRunFinished,
  claimAgentRun,
  createBrokerStreamSink,
  dispatchQueuedAgentRuns,
  endInterruptedAgentRun,
  endLapsedAgentRuns,
  isolateStreamSink,
  sandboxCredentialIssue,
  stopAgentRunChild,
  WorkflowResumeDispatchError,
  withAgentActivityStream,
  workflowAgentNodeQueueJobId,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { createSixbError } from "@sixb/core/internal/errors"
import {
  enqueueAiModelCallRecovery,
  isPermanentAiUsageRecoveryError,
  recordRecoveredAiModelCall,
} from "@sixb/core/internal/model-execution"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { QueueWorker } from "@sixb/core/internal/workers"
import type { AgentQueueJob, ClaimedQueueJob } from "@sixb/core/queues"
import type {
  AgentRunRecord,
  ConversationAgentRunRecord,
  ExecutionRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES } from "@sixb/core/storage"
import { normalizeApiBaseUrl } from "./api-url"
import { repairAgentApprovals } from "./approval-repair"
import { ChildRunner } from "./child-runner"
import { isPermanentAgentPreparationError, MAX_AGENT_DELIVERY_ATTEMPTS } from "./delivery-policy"
import { AgentRunOwnedElsewhereError } from "./errors"
import { keepsSubagentWorkspace } from "./persistent-run-sandbox"
import {
  isTerminalRun,
  PRESTART_RETRY_BACKOFF_MS,
  projectLease,
  retryPreparationInPlace,
  waitForAbort,
} from "./run-fate"
import { conversationSandbox } from "./run-sandboxes"
import type {
  AgentRunnerContext,
  AgentWorkerContext,
  AgentWorkerHost,
  AgentWorkerOptions,
  AgentWorkerStorage,
} from "./types"
import { executeWorkflowAgentNode } from "./workflow-node-execution"

const DEFAULT_AGENT_QUEUE_LEASE_MS = 60_000
const DEFAULT_AGENT_CONCURRENCY = 8
const DEFAULT_SUBAGENT_CONCURRENCY = 4
const DEFAULT_SUBAGENT_CONCURRENCY_PER_RUN = 4
/** Request paths publish their own jobs; this pass only repairs a publication or cancel they lost. */
const AGENT_DISPATCH_REPAIR_MS = 30_000
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
/** Floor for a duplicate's deferral, so a skewed lease clock cannot make it redeliver at once. */
const OWNED_ELSEWHERE_MIN_DEFER_MS = 1_000
const AI_USAGE_RECOVERY_INITIAL_BACKOFF_MS = 5_000
const AI_USAGE_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000

/** What a conversation turn resolves before its first model call. */
/**
 * Cohosted worker that turns durable queued agent runs into executing turns.
 *
 * The queue delivery owns liveness and redelivery. Each claim installs a fresh execution token on
 * the durable run; storage checks that token to fence late writes from stale deliveries. A run's
 * terminal fate lives on its record, so a model/tool failure that we successfully record still
 * acknowledges the job. The job is only left for redelivery when we **cannot** record the fate
 * (storage unavailable) — acking then would leave the thread silently locked forever, since nothing
 * else reclaims a run but a redelivered job.
 */
export class AgentWorker extends QueueWorker<AgentQueueJob, typeof AGENT_RUN_FAILURE_CODES> {
  private readonly host: AgentWorkerHost
  private readonly context: AgentWorkerContext | null
  /** Runs the children of this worker's turns, in this process. */
  private readonly children: ChildRunner | null
  private readonly leaseMs: number
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
      failureCodes: AGENT_RUN_FAILURE_CODES,
      workerId: `agent-worker-${host.id}`,
      claimLimit: options.concurrency ?? DEFAULT_AGENT_CONCURRENCY,
      leaseMs,
    })

    this.host = host
    this.leaseMs = leaseMs
    const hasAgentWork =
      host.definitions.models?.language !== undefined ||
      host.definitions.workflows
        .list()
        .some((workflow) => workflow.nodes.some((node) => node.type === "agent"))
    this.context = hasAgentWork ? buildAgentContext(host, options) : null
    this.children = this.context
      ? new ChildRunner({
          host,
          context: this.context,
          sessions: this.sessionHost(this.context),
          capacity: normalizeConcurrency(
            "subagentConcurrency",
            options.subagentConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY
          ),
          trackTeardown: (teardown) => this.trackTeardown(teardown),
          reportFailure: (error, run, failure) => this.reportFailure(error, run, 1, failure),
        })
      : null
  }

  protected override async run(signal: AbortSignal): Promise<void> {
    if (this.context) {
      const context = this.context
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
    await super.run(signal)
  }

  override async stop(): Promise<void> {
    // super.stop() awaits every in-flight execute() (and thus its dispose()); draining afterwards
    // catches the detached teardowns dispose() left running so we never report stopped while a
    // sandbox machine is still being reaped.
    await super.stop()
    await this.children?.drain()
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
    const { job } = claimed
    if (job.type === "agent.ai-usage.record.requested") {
      await recordRecoveredAiModelCall(this.host.storage, job)
      return
    }
    const context = this.requireContext()
    if (job.type === "agent.workflow-node.requested") {
      await executeWorkflowAgentNode({
        context,
        host: this.host,
        job,
        signal,
        delivery,
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
    if (queuedRun.kind !== "conversation") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Primary queue job '${job.id}' references non-conversational run '${runId}'.`,
        { details: agentRunFailureDetails(queuedRun) }
      )
    }
    if (queuedRun.status !== "queued" && queuedRun.status !== "running") {
      return
    }
    // A conversation turn left running by a dead delivery already streamed to the user and billed
    // its model calls. Replaying it would repeat both behind their back, so it ends interrupted and
    // the user chooses whether to run it again. A delivery whose projected lease has not lapsed may
    // still be alive: this job is then a duplicate and comes back once that lease runs out.
    if (queuedRun.status === "running") {
      const ownedUntil = queuedRun.execution?.queueLeaseExpiresAt
      if (ownedUntil && ownedUntil.getTime() > Date.now()) {
        throw new AgentRunOwnedElsewhereError(queuedRun.id, ownedUntil)
      }
      await endInterruptedAgentRun(this.sessionHost(context), queuedRun, this.leaseMs)
      return
    }
    // Own this attempt before preparation: even a revoked authority needs a fenced terminal outcome.
    const session = await claimAgentRun(this.sessionHost(context), {
      run: queuedRun,
      modelId: queuedRun.spec?.model.modelId,
      leaseExpiresAt: delivery.leaseExpiresAt,
      stop: signal,
    })
    if (!session) return
    const run = session.run
    let stopOwnershipProjection: (() => void) | undefined
    try {
      // The queue remains the sole source of ownership timing. Persist its latest confirmed
      // expiration so a run token can fail closed without maintaining another heartbeat.
      stopOwnershipProjection = projectLease(delivery, session, "agent")
      await runConversationTurn({
        session,
        signal,
        runner: {
          settings: runSettings(context),
          prepare: (prepare) =>
            retryPreparationInPlace(
              job.attempt,
              AbortSignal.any([signal, session.cancelled]),
              async () => {
                // Catch a renewal that completed between starting the run and attaching the
                // observer. Storage keeps this projection monotonic, so racing confirmations are safe.
                await session.renewLease(delivery.leaseExpiresAt)
                return prepare()
              }
            ),
          openSandbox: (turn) => async (lifecycle) =>
            conversationSandbox({
              context: await this.runnerContext(context, session, turn),
              session,
              run,
              thread: turn.thread,
              ...(this.host.sandboxDefinition === undefined
                ? {}
                : { definition: this.host.sandboxDefinition }),
            })(lifecycle),
          startChild: (child, family) =>
            this.requireChildren().start(child, { signal, delivery, family }),
          onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
          reportFailure: (error, failedRun, failure) =>
            this.reportFailure(error, failedRun, job.attempt, failure),
        },
      })
    } finally {
      // Its children end before its delivery does: that delivery renews their lease too.
      await this.children?.stopChildrenOf(run.id)
      stopOwnershipProjection?.()
      await session.close()
    }
  }

  /**
   * A turn's context, with what the worker's sandboxes need besides: its factory, and the run's
   * SDK, which resolves a workspace recipe's parameters.
   */
  private async runnerContext(
    context: AgentWorkerContext,
    session: AgentRunSession<ConversationAgentRunRecord>,
    turn: { readonly context: AgentExecutionContext; readonly execution: ExecutionRecord }
  ): Promise<AgentRunnerContext> {
    return {
      ...turn.context,
      sandboxes: context.sandboxes,
      sixb: bindDurableAgentExecution(this.host, {
        execution: turn.execution,
        runId: session.run.id,
        authorization: await session.authorization(turn.execution.authorizationRef),
      }),
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
    if (error instanceof AgentRunOwnedElsewhereError) return retryOnceReleased(error)
    // The node's result is durable; only its workflow resume is unpublished. Redeliver until it is.
    if (error instanceof WorkflowResumeDispatchError) {
      console.error(`${error.message} Retrying.`, error.cause)
      return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
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
    const permanent = isPermanentAgentPreparationError(error)

    // Storage/identity setup failed before queued→running. Keep the deterministic queue job alive;
    // if the dependency never recovers, record a visible pre-stream failure before dead-lettering.
    if (!permanent && claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS) {
      return { kind: "retry", availableAt: backoff(PRESTART_RETRY_BACKOFF_MS) }
    }
    if (claimed.job.type !== "agent.run.requested" || !this.context) return { kind: "fail" }
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
    // A deferred duplicate stays deferred during shutdown: failing it would orphan a live run.
    if (error instanceof AgentRunOwnedElsewhereError) return retryOnceReleased(error)
    // Shutdown reached us before we could record the run's fate: redeliver so another process
    // finalizes it. Otherwise the run is already terminal, so fail (no redelivery needed).
    if (error instanceof AgentFinalizationError) {
      return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
    }
    return { kind: "fail" }
  }

  /**
   * Republish queued work and cancel orphaned subagents, at start and then every repair interval.
   * Each read covers only active rows, and the deterministic job ids make republication idempotent.
   * Held calls are repaired in the same pass: expired, run after a crash, and their turns resumed.
   */
  private async runDispatchLoop(context: AgentWorkerContext, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        // Runs whose runner stopped renewing them first: their children's parents end with them.
        await endLapsedAgentRuns(this.sessionHost(context), { leaseMs: this.leaseMs })
        await this.reconcileInactiveParentSubagents(context)
        const results = [
          await dispatchQueuedAgentRuns({
            projectId: context.id,
            storage: context.storage.agents,
            queue: this.host.queues.agents,
          }),
        ]
        const failures = results.flatMap((result) => result.failures)
        if (failures.length > 0) {
          console.error(
            `[SixbAgentWorker] Could not dispatch ${failures.length} queued agent run(s); retrying.`,
            failures[0]?.error
          )
        }
        await this.dispatchWorkflowAgentNodes(context)
      } catch (error) {
        console.error("[SixbAgentWorker] Could not scan queued agent runs; retrying.", error)
      }
      try {
        await repairAgentApprovals({ host: this.host, agents: context.storage.agents })
      } catch (error) {
        console.error("[SixbAgentWorker] Could not repair Agent approvals; retrying.", error)
      }
      await waitForAbort(AGENT_DISPATCH_REPAIR_MS, signal)
    }
  }

  private async dispatchWorkflowAgentNodes(context: AgentWorkerContext): Promise<void> {
    const workflowRuns = context.storage.workflowRuns
    if (!workflowRuns) return
    const queued = await workflowRuns.agentNodes.list({
      projectId: context.id,
      statuses: ["queued"],
      order: "asc",
      limit: 100,
    })
    if (queued.runs.length === 0) return
    await this.host.queues.agents.enqueue({
      projectId: context.id,
      jobs: queued.runs.map((run) => ({
        id: workflowAgentNodeQueueJobId(run.nodeRunId),
        type: "agent.workflow-node.requested" as const,
        payload: { nodeRunId: run.nodeRunId },
      })),
    })
  }

  private async reconcileInactiveParentSubagents(context: AgentWorkerContext): Promise<void> {
    let offset = 0
    for (;;) {
      const active = await context.storage.agents.runs.list({
        projectId: context.id,
        kinds: ["subagent"],
        statuses: ["queued", "running"],
        order: "asc",
        limit: 100,
        offset,
      })
      const children = active.runs.filter(
        (run): run is SubagentRunRecord => run.kind === "subagent"
      )
      if (children.length === 0) return

      const parents = await context.storage.agents.runs.getByIds({
        projectId: context.id,
        ids: [...new Set(children.map((run) => run.parentRunId))],
      })
      const parentsById = new Map(parents.map((run) => [run.id, run]))
      await Promise.all(
        children.map(async (run) => {
          const parent = parentsById.get(run.parentRunId)
          if (parent?.kind === "conversation" && !isTerminalRun(parent)) return
          try {
            await stopAgentRunChild(
              this.sessionHost(context),
              run,
              "The parent Agent run is no longer active."
            )
          } catch (error) {
            console.error(
              `[SixbAgentWorker] Could not reconcile subagent run '${run.id}'; retrying later.`,
              error
            )
          }
        })
      )
      if (!active.hasMore) return
      // The active set may shrink while children are cancelled; a later pass catches any shifted row.
      offset += children.length
    }
  }

  private sessionHost(context: AgentWorkerContext): AgentRunSessionHost {
    return {
      projectId: context.id,
      storage: context.storage,
      broker: this.host.broker,
      recoverAiModelCall: context.recoverAiModelCall,
      events: context.streamSink,
      security: this.host.definitions.security,
      maxActiveChildren: context.subagentConcurrencyPerRun,
      sdk: this.host,
      definitions: this.host.definitions,
      ...(this.host.logging === undefined ? {} : { logging: this.host.logging }),
      afterFinish: (run) => afterAgentRunFinished(this.sessionHost(context), run),
    }
  }

  private requireChildren(): ChildRunner {
    if (!this.children) throw new Error("[SixbAgentWorker] Agent worker has no child runner.")
    return this.children
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

  /** A turn's end stops its children still at work, and resumes it if its calls were decided. */
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
      run:
        run.kind === "conversation"
          ? { runId: run.id, threadId: run.threadId }
          : { runId: run.id, parentRunId: run.parentRunId },
      failure,
    })
  }
}

function buildAgentContext(host: AgentWorkerHost, options: AgentWorkerOptions): AgentWorkerContext {
  const storage = host.storage
  assertAgentWorkerStorage(storage)
  if (!host.sandboxes) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require createSixb({ sandboxes }) for the built-in read and bash tools."
    )
  }
  // A worker host is structural and need not come from `SixbHost`, which checks this at startup.
  if (!host.sandboxes.supportsRequestCredentials) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] ${sandboxCredentialIssue({ supportsRequestCredentials: false })}`
    )
  }
  return {
    id: host.id,
    storage,
    sandboxes: host.sandboxes,
    keepsChildWorkspaces: keepsSubagentWorkspace(host.sandboxes),
    // Normalize the server base URL once here, at the boundary. Everything downstream (the sandbox's
    // API address and run context) consumes it verbatim.
    apiBaseUrl: normalizeApiBaseUrl(normalizeRequiredString(options.apiBaseUrl)),
    streamSink: isolateStreamSink(
      withAgentActivityStream(
        options.streamSink ?? createBrokerStreamSink({ broker: host.broker, projectId: host.id }),
        host.broker
      )
    ),
    recoverAiModelCall: (input) => enqueueAiModelCallRecovery(host.queues.agents, input),
    subagentConcurrencyPerRun: normalizeConcurrency(
      "subagentConcurrencyPerRun",
      options.subagentConcurrencyPerRun ?? DEFAULT_SUBAGENT_CONCURRENCY_PER_RUN
    ),
    locale: host.locale,
    timeZone: host.timeZone,
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
  if (!storage.aiLimits) {
    throw createSixbError(
      "internal.unexpected",
      "[SixbAgentWorker] Agent workers require storage.aiLimits support."
    )
  }
}

function retryOnceReleased(error: AgentRunOwnedElsewhereError): QueueWorkerFailureDecision {
  const availableAt = Math.max(
    error.ownedUntil.getTime(),
    Date.now() + OWNED_ELSEWHERE_MIN_DEFER_MS
  )
  return { kind: "retry", availableAt: new Date(availableAt).toISOString() }
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

function normalizeConcurrency(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent worker option ${name} must be a positive integer.`
    )
  }
  return value
}

/** What every run the worker runs shares, without the worker's own parts. */
function runSettings(context: AgentWorkerContext): AgentRunSettings {
  const { id, apiBaseUrl, subagentConcurrencyPerRun, keepsChildWorkspaces, locale, timeZone } =
    context
  return { id, apiBaseUrl, subagentConcurrencyPerRun, keepsChildWorkspaces, locale, timeZone }
}
