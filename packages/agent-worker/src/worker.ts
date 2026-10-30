import { principalsEqual } from "@sixb/core"
import { bindAgentModelExecution } from "@sixb/core/internal/agent-execution"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  conversationThreadId,
  createBrokerStreamSink,
  dispatchQueuedAgentRuns,
  dispatchQueuedSubagentRuns,
  isolateStreamSink,
  isTerminalOrExecutionGone,
  publishAgentRunCancel,
  sandboxCredentialIssue,
  watchAgentRunCancel,
  withAgentActivityStream,
  workflowAgentNodeQueueJobId,
} from "@sixb/core/internal/agents"
import { reportRunFailure } from "@sixb/core/internal/error-reporting"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import {
  enqueueAiModelCallRecovery,
  isPermanentAiUsageRecoveryError,
  ModelUsageRecordingError,
  recordRecoveredAiModelCall,
} from "@sixb/core/internal/model-execution"
import type { QueueDelivery, QueueWorkerFailureDecision } from "@sixb/core/internal/workers"
import { isAbortError, QueueWorker } from "@sixb/core/internal/workers"
import type { AgentQueueJob, ClaimedQueueJob, SubagentQueueJob } from "@sixb/core/queues"
import type {
  AgentRunRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  AppendAgentMessageInput,
  ConversationAgentRunRecord,
  ExecutionRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { AGENT_RUN_FAILURE_CODES, AgentStorageError } from "@sixb/core/storage"
import { normalizeApiBaseUrl } from "./api-url"
import { repairAgentApprovals, resumeIfDecided } from "./approval-repair"
import { createAskParentTool } from "./ask-parent-tool"
import { prepareAgentModel } from "./context-budget"
import {
  isPermanentAgentPreparationError,
  MAX_AGENT_DELIVERY_ATTEMPTS,
  shouldRetryAgentPreparation,
} from "./delivery-policy"
import {
  AgentEnvironmentSaveError,
  AgentRequesterLeftThreadError,
  AgentRunOwnedElsewhereError,
  AgentTurnInterruptedError,
  AgentTurnTimeoutError,
  isLostExecution,
  WorkflowResumeDispatchError,
} from "./errors"
import { createAgentExecutionContext } from "./execution-context"
import {
  listSandboxModels,
  type ResolvedAgentExecutionPlan,
  resolveAgentExecutionPlan,
  resolveSubagentExecutionPlan,
} from "./execution-plan"
import { type AgentRunFailure, toAgentExecutionFailure, toAgentRunFailure } from "./failure"
import { type ConversationReaders, conversationReaders } from "./message-authors"
import { DEFAULT_MAX_STEPS, runAgentTurn, stoppedByWorker } from "./run-agent-turn"
import {
  type AgentExecutionEnvironment,
  type ConversationAgentExecutionEnvironment,
  createConversationAgentEnvironment,
  createSubagentEnvironment,
} from "./run-environment"
import { runSubagent, type SubagentWork } from "./run-subagent"
import { loadSubagentHistory } from "./subagent-continuation"
import { SubagentInbox } from "./subagent-inbox"
import { SubagentCoordinator } from "./subagent-tools"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type {
  AgentExecutionContext,
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
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000
const MAX_TIMER_DURATION_MS = 2_147_483_647
/** Request paths publish their own jobs; this pass only repairs a publication or cancel they lost. */
const AGENT_DISPATCH_REPAIR_MS = 30_000
/** Backoff before redelivering a job whose run could not be finalized (storage was unavailable). */
const FINALIZE_RETRY_BACKOFF_MS = 5_000
const PRESTART_RETRY_BACKOFF_MS = 5_000
/** A turn's own preparation retries quickly first, so a storage blip does not delay the answer. */
const PREPARATION_RETRY_BACKOFF_MS = [250, 1_000, PRESTART_RETRY_BACKOFF_MS] as const
/** Floor for a duplicate's deferral, so a skewed lease clock cannot make it redeliver at once. */
const OWNED_ELSEWHERE_MIN_DEFER_MS = 1_000
const AI_USAGE_RECOVERY_INITIAL_BACKOFF_MS = 5_000
const AI_USAGE_RECOVERY_MAX_BACKOFF_MS = 5 * 60_000

/** What a conversation turn resolves before its first model call. */
interface PreparedConversationTurn {
  readonly thread: AgentThreadRecord | null
  /** The thread and who can read it now, as the model is told; absent without a thread. */
  readonly conversation?: ConversationReaders
  /** Others were added to the thread, even ones who cannot read it now. */
  readonly shared: boolean
  readonly plan: ResolvedAgentExecutionPlan
  readonly execution: ExecutionRecord
  readonly executionContext: AgentExecutionContext
  readonly model: Awaited<ReturnType<typeof prepareAgentModel>>
}

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
  private readonly subagentWorker: SubagentQueueWorker
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
    })

    this.host = host
    const hasAgentWork =
      host.definitions.models?.language !== undefined ||
      host.definitions.workflows
        .list()
        .some((workflow) => workflow.nodes.some((node) => node.type === "agent"))
    this.context = hasAgentWork ? buildAgentContext(host, options, turnTimeoutMs) : null
    this.subagentWorker = new SubagentQueueWorker(
      this,
      host,
      leaseMs,
      options.subagentConcurrency ?? DEFAULT_SUBAGENT_CONCURRENCY
    )
  }

  override async start(): Promise<void> {
    await Promise.all([
      super.start(),
      ...(this.context === null ? [] : [this.subagentWorker.start()]),
    ])
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
    await Promise.all([super.stop(), this.subagentWorker.stop()])
    await Promise.allSettled([...this.pendingTeardowns])
  }

  override wait(): Promise<void> {
    return Promise.all([super.wait(), this.subagentWorker.wait()]).then(() => undefined)
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
        watchForCancel: (runId) =>
          watchAgentRunCancel({ projectId: this.host.id, broker: this.host.broker }, [runId]),
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
      await this.finishInterruptedTurn(context, queuedRun, delivery)
      return
    }
    // Own this attempt before preparation: even a revoked authority needs a fenced terminal outcome.
    const session = await claimAgentRun(this.sessionHost(context), {
      run: queuedRun,
      modelId: queuedRun.spec?.model.modelId,
      leaseExpiresAt: delivery.leaseExpiresAt,
    })
    if (!session) return
    const run = session.run
    let environment: ConversationAgentExecutionEnvironment | null = null
    let runtime: AgentTurnRuntime | null = null
    let delegation: SubagentCoordinator | undefined
    let stopOwnershipProjection: (() => void) | undefined
    // A user cancel joins the turn's abort sources, so it stops the model stream as a shutdown does.
    const turnSignal = AbortSignal.any([signal, session.cancelled])

    try {
      // The queue remains the sole source of ownership timing. Persist its latest confirmed
      // expiration so a run token can fail closed without maintaining another heartbeat.
      stopOwnershipProjection = projectLease(delivery, session, "agent")
      const prepared = await retryPreparationInPlace(job.attempt, turnSignal, async () => {
        // Catch a renewal that completed between starting the run and attaching the observer.
        // Storage keeps this projection monotonic, so racing confirmations are safe.
        await session.renewLease(delivery.leaseExpiresAt)
        const modelCalls = await session.modelCalls()
        return { ...(await this.prepareConversationTurn(context, session)), modelCalls }
      })
      const plan = Object.freeze({ ...prepared.plan, model: prepared.model.model })

      await session.events.publishStarted(run)
      runtime = createAgentTurnRuntime({
        context: prepared.executionContext,
        run,
        signal: turnSignal,
        modelCalls: prepared.modelCalls,
      })
      bindAgentModelExecution(prepared.executionContext.sixb, {
        signal: runtime.signal,
        accounting: runtime.usageRecorder,
      })
      delegation = new SubagentCoordinator(
        this.host,
        context,
        run,
        session,
        prepared.execution,
        runtime.deadline
      )
      const frameworkTools = await delegation.createTools()
      environment = await createConversationAgentEnvironment({
        session,
        frameworkTools,
        thread: prepared.thread,
        ...(prepared.execution.requestedBy === undefined
          ? {}
          : { requestedBy: prepared.execution.requestedBy }),
        ...(prepared.conversation === undefined ? {} : { conversation: prepared.conversation }),
        shared: prepared.shared,
        sandboxDefinition: this.host.sandboxDefinition,
        preflight: { budget: prepared.model.budget, runtime },
        context: prepared.executionContext,
        plan,
        run,
        signal: runtime.signal,
        onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
      })
      delegation.attach(environment.runFiles)
      // A resumed turn's paused children go on first, as the model reads that they do.
      await delegation.continuePausedChildren(runtime.signal)
      runtime.assertCanContinue()
      const completed = await runAgentTurn({
        context: environment.turnContext,
        plan,
        run,
        session,
        ...(prepared.conversation === undefined ? {} : { conversation: prepared.conversation }),
        signal: turnSignal,
        stopSignal: signal,
        runtime,
        threadContext: environment.threadContext,
        children: await delegation.turnChildren(),
      })
      await this.cancelActiveSubagents(completed.id, "The parent Agent run has finished.")
      if (completed.kind === "conversation") {
        await resumeIfDecided(prepared.executionContext.sixb, completed)
      }
    } catch (caughtError) {
      let error = caughtError
      let environmentSaveFailed = error instanceof AgentEnvironmentSaveError
      // Queue ownership or the durable execution token was lost. Touch nothing; the current
      // delivery will reconcile the run.
      if (isLostExecution(error, signal)) return
      // The turn succeeded but its finalize could not be recorded (storage down). Don't ack: let the
      // job redeliver so a later delivery finalizes the run — onExecutionError turns this into retry.
      if (error instanceof AgentFinalizationError) {
        throw error
      }
      if (environment) {
        try {
          await environment.beforeFinalize()
        } catch (saveError) {
          if (saveError instanceof AgentExecutionLostError) return
          error = saveError
          environmentSaveFailed = true
        }
      }
      // Record the run's terminal fate. `recordFate` retries transient blips; if it cannot
      // record the fate at all it raises `AgentFinalizationError`, which propagates here so the job
      // is redelivered rather than acked with the thread left silently locked. A user cancel is
      // detected off its own signal so it records `cancelled` however the aborted stream surfaced.
      const aborted =
        error instanceof AgentRequesterLeftThreadError ||
        (!environmentSaveFailed &&
          !(error instanceof ModelUsageRecordingError) &&
          (signal.aborted || session.cancelled.aborted || isAbortError(error)))
      // A worker stop, unlike a user cancel, leaves the user something to resume.
      const interrupted = aborted && stoppedByWorker(turnSignal, signal)
      const finalized = await recordFate(
        session,
        aborted ? "cancelled" : "failed",
        interrupted ? new AgentTurnInterruptedError(run.id) : error
      )
      if (finalized) {
        if (finalized.run.status === "failed" && !(error instanceof AgentTurnTimeoutError)) {
          this.reportFailure(error, finalized.run, job.attempt, finalized.failure)
        }
        await session.events.publishRunFinished(finalized.run)
        await this.cancelActiveSubagents(
          finalized.run.id,
          `The parent Agent run was ${finalized.run.status}.`
        )
      }
      // Shutdown abort: rethrow so `onAbortError` releases the job for another process. A user cancel
      // or a recorded model/tool failure keeps its fate on the record, so we ack by returning.
      if (signal.aborted) {
        throw error
      }
    } finally {
      stopOwnershipProjection?.()
      session.close()
      delegation?.close()
      runtime?.dispose()
      await environment?.dispose()
    }
  }

  /**
   * A shared thread's turn waits in the queue: its requester may leave the thread, or be removed,
   * before it starts. Such a turn never reaches the model. A turn already running when they leave
   * finishes, as it already read the thread.
   */
  private assertRequesterTakesPart(
    run: ConversationAgentRunRecord,
    thread: AgentThreadRecord | null,
    participants: readonly AgentThreadParticipantRecord[],
    execution: ExecutionRecord
  ): void {
    const requester = execution.requestedBy
    if (!thread || !requester || principalsEqual(requester, thread.ownerPrincipal)) return
    if (participants.some((participant) => principalsEqual(participant.principal, requester)))
      return

    throw new AgentRequesterLeftThreadError(run.id)
  }

  /** Resolve everything a turn needs before its first model call. */
  private async prepareConversationTurn(
    context: AgentWorkerContext,
    session: AgentRunSession<ConversationAgentRunRecord>
  ): Promise<PreparedConversationTurn> {
    const { run } = session
    const thread = await session.conversation.thread(run.threadId)
    const plan = resolveAgentExecutionPlan({
      spec: run.spec,
      models: this.host.definitions.models?.language,
      tools: this.host.definitions.tools,
      skills: this.host.definitions.agent.skills,
      ...(this.host.definitions.agent.instructions === undefined
        ? {}
        : { projectInstructions: this.host.definitions.agent.instructions }),
      defaultMaxSteps: context.defaultMaxSteps,
      sandboxModels: listSandboxModels(this.host.definitions.models),
    })
    const execution = await session.execution()
    if (!execution) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${run.id}' references missing execution '${run.executionId}'.`,
        { details: { runId: run.id, threadId: run.threadId, executionId: run.executionId } }
      )
    }
    const participants = thread ? await session.conversation.participants([thread.id]) : []
    this.assertRequesterTakesPart(run, thread, participants, execution)

    const conversation = thread
      ? await conversationReaders({
          people: session.people,
          thread,
          participants,
        })
      : undefined

    const executionContext = await createAgentExecutionContext({
      context,
      host: this.host,
      execution,
      runId: run.id,
      people: session.people,
      authorization: await session.people.authorization(execution.authorizationRef),
      shared: (conversation?.participants.length ?? 0) > 0,
    })
    const model = await prepareAgentModel(plan)
    return {
      thread,
      ...(conversation === undefined ? {} : { conversation }),
      // The rule run tokens apply to memory: someone who loses access may regain it,
      // and read back whatever memory the thread held meanwhile.
      shared: participants.length > 0,
      plan,
      execution,
      executionContext,
      model,
    }
  }

  /**
   * End a turn whose delivery died, without calling the model. Reclaiming first rotates the
   * execution token, so a delivery that is only slow, not dead, can no longer write to the run.
   */
  private async finishInterruptedTurn(
    context: AgentWorkerContext,
    queuedRun: AgentRunRecord,
    delivery: { readonly leaseExpiresAt: string }
  ): Promise<void> {
    const session = await claimAgentRun(this.sessionHost(context), {
      run: queuedRun,
      leaseExpiresAt: delivery.leaseExpiresAt,
    })
    if (!session) return
    session.close()

    const finalized = await recordFate(
      session,
      "cancelled",
      queuedRun.kind === "subagent"
        ? withFailureMessage(
            new AgentTurnInterruptedError(queuedRun.id),
            "The subagent stopped when the worker running it did. Spawn it again with a new key if its answer is still needed: what it already changed stays changed."
          )
        : new AgentTurnInterruptedError(queuedRun.id)
    )
    if (!finalized) return
    await session.events.publishRunFinished(finalized.run)
    if (finalized.run.kind === "conversation") {
      await this.cancelActiveSubagents(finalized.run.id, "The parent Agent run was interrupted.")
    }
  }

  async executeSubagent(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<SubagentQueueJob, (typeof AGENT_RUN_FAILURE_CODES)[number]>
  ): Promise<void> {
    const context = this.requireContext()
    const { runId } = claimed.job.payload
    const queuedRun = await context.storage.agents.runs.getById({
      projectId: context.id,
      id: runId,
    })
    if (!queuedRun || queuedRun.kind !== "subagent") {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Queued subagent run '${runId}' was not found.`,
        { details: { runId } }
      )
    }
    if (queuedRun.status !== "queued" && queuedRun.status !== "running") return
    // Like a conversation turn, a child left running by a dead delivery already ran its tools:
    // actions, artifact versions, billed model calls. A replay would repeat them, so it ends
    // interrupted and its parent decides whether to spawn it again.
    if (queuedRun.status === "running") {
      const ownedUntil = queuedRun.execution?.queueLeaseExpiresAt
      if (ownedUntil && ownedUntil.getTime() > Date.now()) {
        throw new AgentRunOwnedElsewhereError(queuedRun.id, ownedUntil)
      }
      await this.finishInterruptedTurn(context, queuedRun, delivery)
      return
    }

    // A child stops with its parent: cancelling the parent cancels it.
    const session = await claimAgentRun(this.sessionHost(context), {
      run: queuedRun,
      modelId: queuedRun.spec.model.modelId,
      leaseExpiresAt: delivery.leaseExpiresAt,
      cancelWith: [queuedRun.parentRunId],
    })
    if (!session) return
    const run = session.run
    const turnSignal = AbortSignal.any([signal, session.cancelled])
    let preparationComplete = false
    let environment: AgentExecutionEnvironment | null = null
    let runtime: AgentTurnRuntime | null = null
    let stopOwnershipProjection: (() => void) | undefined
    const work: SubagentWork = {}

    try {
      const currentParent = await session.conversation.run(run.parentRunId)
      if (!currentParent || currentParent.kind !== "conversation" || isTerminalRun(currentParent)) {
        throw new DOMException("The parent Agent run is no longer active.", "AbortError")
      }

      stopOwnershipProjection = projectLease(delivery, session, "subagent")
      await session.renewLease(delivery.leaseExpiresAt)
      const configuredPlan = resolveSubagentExecutionPlan({
        run: queuedRun,
        models: this.host.definitions.models?.language,
        tools: this.host.definitions.tools,
        skills: this.host.definitions.agent.skills,
        ...(this.host.definitions.agent.instructions === undefined
          ? {}
          : { projectInstructions: this.host.definitions.agent.instructions }),
        sandboxModels: listSandboxModels(this.host.definitions.models),
      })
      const durableExecution = await session.execution()
      if (
        !durableExecution ||
        durableExecution.source.type !== "execution" ||
        durableExecution.source.executionId !== currentParent.executionId
      ) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbAgentWorker] Subagent run '${runId}' has invalid execution lineage.`,
          {
            details: {
              parentRunId: queuedRun.parentRunId,
              runId,
              executionId: queuedRun.executionId,
            },
          }
        )
      }
      const executionContext = await createAgentExecutionContext({
        context,
        host: this.host,
        execution: durableExecution,
        runId: queuedRun.id,
        people: session.people,
        authorization: await session.people.authorization(durableExecution.authorizationRef),
      })
      // The child works in its own thread, and publishes into its conversation's gallery.
      const childThread = await session.conversation.thread(run.threadId)
      if (!childThread) {
        throw createSixbError(
          "internal.unexpected",
          `[SixbAgentWorker] Subagent run '${run.id}' references missing thread '${run.threadId}'.`,
          { details: agentRunFailureDetails(run) }
        )
      }
      const conversation = await session.conversation.thread(conversationThreadId(childThread))
      const prepared = await prepareAgentModel(configuredPlan)
      const plan = Object.freeze({ ...configuredPlan, model: prepared.model })
      const history = await loadSubagentHistory(session, childThread)
      const modelCalls = await session.modelCalls()
      preparationComplete = true
      await session.events.publishStarted(run)
      // The parent's deadline, not one from now: a child that waited in the queue has less left.
      runtime = createAgentTurnRuntime({
        context: executionContext,
        run,
        signal: turnSignal,
        modelCalls,
        ...(run.spec.deadline === undefined ? {} : { deadline: new Date(run.spec.deadline) }),
      })
      bindAgentModelExecution(executionContext.sixb, {
        signal: runtime.signal,
        accounting: runtime.usageRecorder,
      })
      // From the first message: one its parent sent while it was queued is read at its first step,
      // and a continuation's first step reads what the runs before it left unread.
      const inbox = new SubagentInbox(session.mail, run, history.messages)
      environment = await createSubagentEnvironment({
        session,
        context: executionContext,
        plan,
        run,
        thread: childThread,
        conversation,
        frameworkTools: [createAskParentTool(inbox)],
        ...(durableExecution.requestedBy === undefined
          ? {}
          : { requestedBy: durableExecution.requestedBy }),
        history,
        signal: runtime.signal,
        onDetachedTeardown: (teardown) => this.trackTeardown(teardown),
      })
      await runSubagent({
        history,
        inbox,
        context: environment.turnContext,
        plan,
        run,
        session,
        thread: childThread,
        runtime,
        work,
        runFiles: environment.runFiles,
      })
    } catch (error) {
      if (isLostExecution(error, signal)) return
      if (error instanceof AgentFinalizationError) throw error
      // A child run that fails or is stopped leaves its workspace mid-work: it goes, and a later
      // continuation of the thread starts again from the handed files and out/. The run's own
      // error is the one recorded, a save that failed included.
      try {
        await environment?.beforeFinalize({ discard: true })
      } catch (saveError) {
        if (saveError instanceof AgentExecutionLostError) return
      }
      if (
        !preparationComplete &&
        !turnSignal.aborted &&
        !isAbortError(error) &&
        shouldRetryAgentPreparation(error, claimed.job.attempt)
      ) {
        throw error
      }

      const aborted =
        !(error instanceof ModelUsageRecordingError) &&
        (signal.aborted || session.cancelled.aborted || isAbortError(error))
      const finalized = await recordFate(
        session,
        aborted ? "cancelled" : "failed",
        error,
        work.messages
      )
      if (finalized) {
        if (finalized.run.status === "failed" && !(error instanceof AgentTurnTimeoutError)) {
          this.reportFailure(error, finalized.run, claimed.job.attempt, finalized.failure)
        }
        await session.events.publishRunFinished(finalized.run)
      }
      if (signal.aborted) throw error
    } finally {
      stopOwnershipProjection?.()
      session.close()
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

  async onSubagentExecutionError(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof AGENT_RUN_FAILURE_CODES)[number]>> {
    if (error instanceof AgentRunOwnedElsewhereError) return retryOnceReleased(error)
    if (
      error instanceof AgentFinalizationError &&
      claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS
    ) {
      return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
    }

    const retryable = !isPermanentAgentPreparationError(error)
    if (retryable && claimed.job.attempt < MAX_AGENT_DELIVERY_ATTEMPTS) {
      return { kind: "retry", availableAt: backoff(PRESTART_RETRY_BACKOFF_MS) }
    }

    const terminalized = await this.terminalizeSubagentDeliveryFailure(claimed, error)
    return terminalized ? { kind: "fail", failure: terminalized } : { kind: "fail" }
  }

  onSubagentAbortError(
    _claimed: ClaimedQueueJob<SubagentQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    // A deferred duplicate stays deferred during shutdown: failing it would orphan a live run.
    if (error instanceof AgentRunOwnedElsewhereError) return retryOnceReleased(error)
    return { kind: "retry", availableAt: backoff(FINALIZE_RETRY_BACKOFF_MS) }
  }

  /**
   * Republish queued work and cancel orphaned subagents, at start and then every repair interval.
   * Each read covers only active rows, and the deterministic job ids make republication idempotent.
   * Held calls are repaired in the same pass: expired, run after a crash, and their turns resumed.
   */
  private async runDispatchLoop(context: AgentWorkerContext, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.reconcileInactiveParentSubagents(context)
        const results = [
          await dispatchQueuedAgentRuns({
            projectId: context.id,
            storage: context.storage.agents,
            queue: this.host.queues.agents,
          }),
          await dispatchQueuedSubagentRuns({
            projectId: context.id,
            storage: context.storage.agents,
            queue: this.host.queues.agentChildren,
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

  private async cancelActiveSubagents(parentRunId: string, message: string): Promise<void> {
    const context = this.requireContext()
    let children: readonly AgentRunRecord[]
    try {
      children = (
        await context.storage.agents.runs.list({
          projectId: context.id,
          kinds: ["subagent"],
          parentRunId,
          statuses: ["queued", "running"],
          order: "asc",
          limit: 100,
        })
      ).runs
    } catch (error) {
      console.error(
        `[SixbAgentWorker] Could not list active children for Agent run '${parentRunId}'; reconciliation will retry.`,
        error
      )
      return
    }

    await Promise.all(
      children.map(async (candidate) => {
        if (candidate.kind !== "subagent") return
        try {
          await this.requestSubagentCancellation(candidate, message)
        } catch (error) {
          console.error(
            `[SixbAgentWorker] Could not cancel subagent run '${candidate.id}'; reconciliation will retry.`,
            error
          )
        }
      })
    )
  }

  private async requestSubagentCancellation(
    run: SubagentRunRecord,
    message: string
  ): Promise<void> {
    const context = this.requireContext()
    if (run.status === "running") {
      await publishAgentRunCancel(this.host.broker, { projectId: context.id, runId: run.id })
      return
    }
    if (run.status !== "queued") return

    const completedAt = new Date()
    const error = toAgentRunFailure(
      createSixbError("runtime.cancelled", message, {
        details: agentRunFailureDetails(run),
      }),
      { status: "cancelled", at: completedAt, details: agentRunFailureDetails(run) }
    )
    try {
      const cancelled = await context.storage.agents.runs.finishQueued({
        projectId: context.id,
        id: run.id,
        status: "cancelled",
        error,
        completedAt,
      })
      await context.streamSink.publishRunFinished(cancelled)
    } catch (failure) {
      if (!(failure instanceof AgentStorageError) || failure.code !== "invalid_state") throw failure
      const current = await context.storage.agents.runs.getById({
        projectId: context.id,
        id: run.id,
      })
      if (current?.kind === "subagent" && current.status === "running") {
        await publishAgentRunCancel(this.host.broker, { projectId: context.id, runId: run.id })
      }
    }
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
            await this.requestSubagentCancellation(run, "The parent Agent run is no longer active.")
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

  private async terminalizeSubagentDeliveryFailure(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    error: unknown
  ): Promise<AgentRunFailure | undefined> {
    const context = this.requireContext()
    const loaded = await context.storage.agents.runs.getById({
      projectId: context.id,
      id: claimed.job.payload.runId,
    })
    if (!loaded || loaded.kind !== "subagent" || isTerminalRun(loaded)) return loaded?.error

    const completedAt = new Date()
    const failure = toAgentRunFailure(error, {
      status: "failed",
      at: completedAt,
      details: agentRunFailureDetails(loaded),
    })
    if (loaded.status === "queued") {
      const failed = await context.storage.agents.runs.finishQueued({
        projectId: context.id,
        id: loaded.id,
        status: "failed",
        error: failure,
        completedAt,
      })
      this.reportFailure(error, failed, claimed.job.attempt, failure)
      await context.streamSink.publishRunFinished(failed)
      return failure
    }

    // A preparation failure must only finish the token acquired by that delivery in executeSubagent.
    // Never reclaim a running child from an error handler: another delivery may already own it.
    return undefined
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

  private sessionHost(context: AgentWorkerContext): AgentRunSessionHost {
    return {
      projectId: context.id,
      storage: context.storage,
      broker: this.host.broker,
      recoverAiModelCall: context.recoverAiModelCall,
      events: context.streamSink,
      childQueue: this.host.queues.agentChildren,
      security: this.host.definitions.security,
    }
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
      run:
        run.kind === "conversation"
          ? { runId: run.id, threadId: run.threadId }
          : { runId: run.id, parentRunId: run.parentRunId },
      failure,
    })
  }
}

class SubagentQueueWorker extends QueueWorker<SubagentQueueJob, typeof AGENT_RUN_FAILURE_CODES> {
  constructor(
    private readonly owner: AgentWorker,
    host: AgentWorkerHost,
    leaseMs: number,
    concurrency: number
  ) {
    super({
      projectId: host.id,
      queue: host.queues.agentChildren,
      failureCodes: AGENT_RUN_FAILURE_CODES,
      workerId: `subagent-worker-${host.id}`,
      claimLimit: concurrency,
      leaseMs,
    })
  }

  protected execute(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    signal: AbortSignal,
    delivery: QueueDelivery<SubagentQueueJob, (typeof AGENT_RUN_FAILURE_CODES)[number]>
  ): Promise<void> {
    return this.owner.executeSubagent(claimed, signal, delivery)
  }

  protected override onExecutionError(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    error: unknown
  ): Promise<QueueWorkerFailureDecision<(typeof AGENT_RUN_FAILURE_CODES)[number]>> {
    return this.owner.onSubagentExecutionError(claimed, error)
  }

  protected override onAbortError(
    claimed: ClaimedQueueJob<SubagentQueueJob>,
    error: unknown
  ): QueueWorkerFailureDecision {
    return this.owner.onSubagentAbortError(claimed, error)
  }
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
    logging: host.logging,
    valueTypesById: host.definitions.ontology.getValueTypesById(),
    ontologyDocs: host.definitions.agent.ontologyDocs,
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
    defaultMaxSteps: options.defaultMaxSteps ?? DEFAULT_MAX_STEPS,
    turnTimeoutMs,
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

/**
 * Record the queue's renewals on the run: a run token fails closed once the lease last recorded
 * lapses, so it needs no heartbeat of its own. Returns the stop.
 */
function projectLease(
  delivery: { onLeaseRenewed(listener: (renewed: { leaseExpiresAt: string }) => void): () => void },
  session: AgentRunSession,
  kind: "agent" | "subagent"
): () => void {
  return delivery.onLeaseRenewed((renewed) => {
    void session.renewLease(renewed.leaseExpiresAt).catch((error: unknown) => {
      if (!isTerminalOrExecutionGone(error)) {
        console.error(
          `[SixbAgentWorker] Could not project queue ownership for ${kind} run '${session.run.id}'.`,
          error
        )
      }
    })
  })
}

/**
 * End a run that failed or stopped, with what it did kept in the same transaction. Returns
 * nothing when the run is no longer this session's; throws {@link AgentFinalizationError} when
 * storage stays unavailable, so the job is redelivered rather than acknowledged.
 */
async function recordFate(
  session: AgentRunSession,
  status: "failed" | "cancelled",
  error: unknown,
  messages?: readonly AppendAgentMessageInput[]
): Promise<{ readonly run: AgentRunRecord; readonly failure: AgentRunFailure } | undefined> {
  const { run } = session
  const completedAt = new Date()
  const failure = toAgentExecutionFailure(error, {
    status,
    at: completedAt,
    details: {
      ...agentRunFailureDetails(run),
      ...(error instanceof AgentTurnTimeoutError ? { timeoutMs: String(error.timeoutMs) } : {}),
    },
  })
  try {
    const finalized = await session.finish(
      {
        status,
        error: failure,
        completedAt,
        ...(error instanceof AgentTurnTimeoutError ? { finishReason: "timeout" as const } : {}),
        ...(error instanceof AgentTurnInterruptedError
          ? { finishReason: "interrupted" as const }
          : {}),
      },
      messages
    )
    return { run: finalized, failure }
  } catch (finishError) {
    if (finishError instanceof AgentExecutionLostError) return undefined
    throw finishError
  }
}

/** Come back once the owning delivery's projected lease lapses, and never sooner than a moment. */
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

function agentRunFailureDetails(run: AgentRunRecord): Readonly<Record<string, string>> {
  return run.kind === "conversation"
    ? { runId: run.id, threadId: run.threadId }
    : { parentRunId: run.parentRunId, runId: run.id }
}

function isTerminalRun(run: AgentRunRecord): boolean {
  return run.status !== "queued" && run.status !== "running"
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

/**
 * Preparation calls no model and no tool, so a dependency failure is retried here, within the
 * delivery that owns the run. A redelivery would find the run running and end it as interrupted.
 */
async function retryPreparationInPlace<T>(
  attempt: number,
  signal: AbortSignal,
  prepare: () => Promise<T>
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    try {
      return await prepare()
    } catch (error) {
      if (
        signal.aborted ||
        isTerminalOrExecutionGone(error) ||
        !shouldRetryAgentPreparation(error, attempt + retry)
      ) {
        throw error
      }
    }
    const backoffMs = PREPARATION_RETRY_BACKOFF_MS[retry] ?? PRESTART_RETRY_BACKOFF_MS
    await waitForAbort(backoffMs, signal)
    signal.throwIfAborted()
  }
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
