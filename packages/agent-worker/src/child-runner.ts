import {
  type AgentExecutionEnvironment,
  type AgentRunFailure,
  type AgentTurnRuntime,
  AgentTurnTimeoutError,
  createAgentTurnRuntime,
  createAskParentTool,
  createSubagentEnvironment,
  isLostExecution,
  listSandboxModels,
  prepareAgentModel,
  resolveSubagentExecutionPlan,
  runSubagent,
  SubagentInbox,
  type SubagentWork,
  stoppedByWorker,
  toAgentRunFailure,
} from "@sixb/agent"
import { bindAgentModelExecution } from "@sixb/core/internal/agent-execution"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  type AgentRunSession,
  type AgentRunSessionHost,
  claimAgentRun,
  interruptedError,
  isTerminalOrExecutionGone,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { ModelUsageRecordingError } from "@sixb/core/internal/model-execution"
import type { QueueDelivery } from "@sixb/core/internal/workers"
import { isAbortError } from "@sixb/core/internal/workers"
import type { AgentQueueJob } from "@sixb/core/queues"
import type { AgentRunRecord, SubagentRunRecord } from "@sixb/core/storage"
import { isPermanentAgentPreparationError } from "./delivery-policy"
import { createAgentExecutionContext } from "./execution-context"
import {
  agentRunFailureDetails,
  isTerminalRun,
  PREPARATION_RETRY_BACKOFF_MS,
  PRESTART_RETRY_BACKOFF_MS,
  projectLease,
  recordFate,
  retryPreparationInPlace,
  waitForAbort,
} from "./run-fate"
import { childSandbox } from "./run-sandboxes"
import type { AgentWorkerContext, AgentWorkerHost } from "./types"

/** The delivery a child runs under: its parent's, whose lease and stop signal it shares. */
export interface ParentDelivery {
  readonly signal: AbortSignal
  readonly delivery: Pick<QueueDelivery<AgentQueueJob>, "leaseExpiresAt" | "onLeaseRenewed">
}

interface RunningChild {
  readonly parentRunId: string
  /** Aborted when the parent's turn ends while the child still runs. */
  readonly ended: AbortController
  readonly done: Promise<void>
}

/** What the worker lends its child runner. */
export interface ChildRunnerDeps {
  readonly host: AgentWorkerHost
  readonly context: AgentWorkerContext
  readonly sessions: AgentRunSessionHost
  /** How many children run here at once, across every turn; the rest wait their turn queued. */
  readonly capacity: number
  trackTeardown(teardown: Promise<void>): void
  reportFailure(error: unknown, run: AgentRunRecord, failure: AgentRunFailure): void
}

/**
 * Runs the children a turn spawns, beside the turn, in its runner. A child holds its own run,
 * session, token and sandbox, but no delivery of its own: its parent's lease is its lease, and a
 * runner that stops takes its children with it. The worker's repair pass ends a child left running
 * once its parent ended and its lease lapsed.
 */
export class ChildRunner {
  /** Children running here, by run id: a child already running is never started twice. */
  private readonly running = new Map<string, RunningChild>()
  /** Children holding one of the runner's slots, and those waiting for one, first come first. */
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly deps: ChildRunnerDeps) {}

  /**
   * Run a child under its parent's delivery, in this process. It records the child's fate itself
   * and never rejects; a run already running here is left alone.
   */
  start(run: SubagentRunRecord, parent: ParentDelivery): void {
    if (this.running.has(run.id)) return
    const ended = new AbortController()
    const done = this.run(run, parent, ended.signal).catch((error: unknown) => {
      console.error(`[SixbAgentWorker] Subagent run '${run.id}' failed outside its run.`, error)
    })
    this.running.set(run.id, { parentRunId: run.parentRunId, ended, done })
    void done.finally(() => this.running.delete(run.id))
  }

  /**
   * Stop a parent's children still running here, and wait for them to record it. Its end cancels
   * them through the broker too; this needs no broker, and keeps the parent's delivery, which
   * renews their lease, open until they have ended.
   */
  async stopChildrenOf(parentRunId: string): Promise<void> {
    const children = [...this.running.values()].filter((child) => child.parentRunId === parentRunId)
    for (const child of children) {
      child.ended.abort(new DOMException("The parent Agent run has ended.", "AbortError"))
    }
    await Promise.allSettled(children.map((child) => child.done))
  }

  /** Wait for every child running here, for a worker that stops. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((child) => child.done))
  }

  private async run(
    queuedRun: SubagentRunRecord,
    parent: ParentDelivery,
    parentEnded: AbortSignal
  ): Promise<void> {
    const stopped = AbortSignal.any([parent.signal, parentEnded])
    if (!(await this.takeSlot(stopped))) return
    try {
      await this.runClaimed(queuedRun, parent, stopped)
    } finally {
      this.releaseSlot()
    }
  }

  /** Wait for one of the runner's child slots: false once the child stops first. */
  private takeSlot(stopped: AbortSignal): Promise<boolean> {
    if (stopped.aborted) return Promise.resolve(false)
    if (this.active < this.deps.capacity) {
      this.active += 1
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const granted = (): void => {
        stopped.removeEventListener("abort", gaveUp)
        resolve(true)
      }
      const gaveUp = (): void => {
        this.waiting.splice(this.waiting.indexOf(granted), 1)
        resolve(false)
      }
      this.waiting.push(granted)
      stopped.addEventListener("abort", gaveUp, { once: true })
    })
  }

  /** A slot a child let go of passes to the child waiting longest. */
  private releaseSlot(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active -= 1
  }

  /**
   * Claim a queued child, retrying for as long as its parent runs: nothing redelivers a child, and
   * its parent waits on it. One its claim refuses for good ends failed, so its parent's wait
   * returns. Once the parent ends, the repair pass ends a child still queued.
   */
  private async claim(
    queuedRun: SubagentRunRecord,
    parent: ParentDelivery,
    stopped: AbortSignal
  ): Promise<AgentRunSession<SubagentRunRecord> | null> {
    let refused: unknown
    for (let retry = 0; ; retry += 1) {
      try {
        if (refused !== undefined) {
          await this.failQueued(queuedRun, refused)
          return null
        }
        return await claimAgentRun(this.deps.sessions, {
          run: queuedRun,
          modelId: queuedRun.spec.model.modelId,
          leaseExpiresAt: parent.delivery.leaseExpiresAt,
          cancelWith: [queuedRun.parentRunId],
        })
      } catch (error) {
        if (stopped.aborted || isTerminalOrExecutionGone(error)) return null
        if (refused === undefined && isPermanentAgentPreparationError(error)) {
          refused = error
          continue
        }
        if (retry === 0) {
          console.error(
            `[SixbAgentWorker] Could not claim subagent run '${queuedRun.id}'; retrying while its parent runs.`,
            error
          )
        }
      }
      await waitForAbort(PREPARATION_RETRY_BACKOFF_MS[retry] ?? PRESTART_RETRY_BACKOFF_MS, stopped)
      if (stopped.aborted) return null
    }
  }

  private async failQueued(run: SubagentRunRecord, error: unknown): Promise<void> {
    const { context } = this.deps
    const completedAt = new Date()
    const failure = toAgentRunFailure(error, {
      status: "failed",
      at: completedAt,
      details: agentRunFailureDetails(run),
    })
    const failed = await context.storage.agents.runs.finishQueued({
      projectId: context.id,
      id: run.id,
      status: "failed",
      error: failure,
      completedAt,
    })
    this.deps.reportFailure(error, failed, failure)
    await context.streamSink.publishRunFinished(failed)
  }

  private async runClaimed(
    queuedRun: SubagentRunRecord,
    parent: ParentDelivery,
    stopped: AbortSignal
  ): Promise<void> {
    const { signal, delivery } = parent
    // A child stops with its parent: cancelling the parent cancels it.
    const session = await this.claim(queuedRun, parent, stopped)
    if (!session) return
    const run = session.run
    const turnSignal = AbortSignal.any([stopped, session.cancelled])
    let environment: AgentExecutionEnvironment | null = null
    let runtime: AgentTurnRuntime | null = null
    let stopOwnershipProjection: (() => void) | undefined
    const work: SubagentWork = {}

    try {
      // The parent's delivery holds the child's lease too: its renewals renew both. One that
      // landed while the child was claimed is recorded now.
      stopOwnershipProjection = projectLease(delivery, session, "subagent")
      await session.renewLease(delivery.leaseExpiresAt)
      const prepared = await retryPreparationInPlace(1, turnSignal, () =>
        this.prepare(session, queuedRun)
      )
      const { executionContext, durableExecution, childThread, conversation, plan, history } =
        prepared
      await session.events.publishStarted(run)
      // The parent's deadline, not one from now: a child that started late has less left.
      runtime = createAgentTurnRuntime({
        context: executionContext,
        run,
        signal: turnSignal,
        modelCalls: prepared.modelCalls,
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
        openSandbox: childSandbox({ context: executionContext, session, run, thread: childThread }),
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
        onDetachedTeardown: (teardown) => this.deps.trackTeardown(teardown),
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
      // Its end could not be recorded: it stays running until its lease lapses, and the repair
      // pass then ends it as interrupted.
      if (error instanceof AgentFinalizationError) {
        console.error(error.message, error.cause)
        return
      }
      // A child run that fails or is stopped leaves its workspace mid-work: it goes, and a later
      // continuation of the thread starts again from the handed files and out/. The run's own
      // error is the one recorded, a save that failed included.
      try {
        await environment?.beforeFinalize({ discard: true })
      } catch (saveError) {
        if (saveError instanceof AgentExecutionLostError) return
      }
      const aborted =
        !(error instanceof ModelUsageRecordingError) &&
        (stopped.aborted || session.cancelled.aborted || isAbortError(error))
      // A worker stop takes its turns' children with it, and nothing replays them.
      const interrupted = aborted && stoppedByWorker(turnSignal, signal)
      const finalized = await recordFate(
        session,
        aborted ? "cancelled" : "failed",
        interrupted ? interruptedError(run) : error,
        work.messages
      )
      if (finalized) {
        if (finalized.run.status === "failed" && !(error instanceof AgentTurnTimeoutError)) {
          this.deps.reportFailure(error, finalized.run, finalized.failure)
        }
        await session.events.publishRunFinished(finalized.run)
      }
    } finally {
      stopOwnershipProjection?.()
      session.close()
      runtime?.dispose()
      await environment?.dispose()
    }
  }

  /** Everything a child needs before its first model call, read through its session. */
  private async prepare(session: AgentRunSession<SubagentRunRecord>, queuedRun: SubagentRunRecord) {
    const { host, context } = this.deps
    const { run } = session
    const runId = run.id
    const child = await session.context()
    if (child.kind !== "subagent") throw new Error(`[SixbAgentWorker] Run '${runId}' changed kind.`)
    const { parent: currentParent, execution: durableExecution, thread: childThread } = child
    if (!currentParent || currentParent.kind !== "conversation" || isTerminalRun(currentParent)) {
      throw new DOMException("The parent Agent run is no longer active.", "AbortError")
    }
    const configuredPlan = resolveSubagentExecutionPlan({
      run: queuedRun,
      models: host.definitions.models?.language,
      tools: host.definitions.tools,
      skills: host.definitions.agent.skills,
      ...(host.definitions.agent.instructions === undefined
        ? {}
        : { projectInstructions: host.definitions.agent.instructions }),
      sandboxModels: listSandboxModels(host.definitions.models),
    })
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
      host,
      execution: durableExecution,
      runId: queuedRun.id,
      names: child.names,
      authorization: await session.people.authorization(durableExecution.authorizationRef),
    })
    // The child works in its own thread, and publishes into its conversation's gallery.
    if (!childThread) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Subagent run '${run.id}' references missing thread '${run.threadId}'.`,
        { details: agentRunFailureDetails(run) }
      )
    }
    const { conversation } = child
    const prepared = await prepareAgentModel(configuredPlan)
    const plan = Object.freeze({ ...configuredPlan, model: prepared.model })
    const history = { messages: child.messages, ...(child.paused ? { paused: child.paused } : {}) }
    const modelCalls = await session.modelCalls()
    return {
      executionContext,
      durableExecution,
      childThread,
      conversation,
      plan,
      history,
      modelCalls,
    }
  }
}
