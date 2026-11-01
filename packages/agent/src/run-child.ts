import {
  AgentExecutionLostError,
  AgentFinalizationError,
  type AgentRunSession,
  interruptedError,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { ModelUsageRecordingError } from "@sixb/core/internal/model-execution"
import { isAbortError } from "@sixb/core/internal/workers"
import type {
  AgentRunRecord,
  AgentThreadRecord,
  ExecutionRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { createAskParentTool } from "./ask-parent-tool"
import { prepareAgentModel } from "./context-budget"
import { isLostExecution } from "./errors"
import { resolveRunPlan } from "./execution-plan"
import type { AgentRunFailure } from "./failure"
import type { FamilyMailbox } from "./family-mailbox"
import { agentRequester } from "./requester"
import { stoppedByWorker } from "./run-agent-turn"
import {
  type AgentExecutionEnvironment,
  createSubagentEnvironment,
  type OpenRunSandbox,
} from "./run-environment"
import { agentRunFailureDetails, recordFate } from "./run-fate"
import { runSubagent, type SubagentWork } from "./run-subagent"
import { SubagentInbox } from "./subagent-inbox"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentExecutionContext, AgentRunSettings } from "./types"

// The children a turn spawns, run beside it in its runner: the worker, or a runner on a computer.
// The runner keeps what is its own: how a child is claimed, and where its sandbox comes from.

/** What a runner lends the children it runs. */
export interface ChildRunnerHost {
  /** What every run of the project shares. */
  readonly settings: AgentRunSettings
  /** How many children run here at once, across every turn; the rest wait their turn queued. */
  readonly capacity: number
  /**
   * Claim a queued child, retrying while `stop` holds: nothing redelivers a child, and its parent
   * waits on it. Null when it can't be claimed, such as once its parent ended.
   */
  claim(
    run: SubagentRunRecord,
    claim: { readonly leaseExpiresAt: string; readonly stop: AbortSignal }
  ): Promise<AgentRunSession<SubagentRunRecord> | null>
  /** The sandbox the child works in, opened when it first needs one. */
  openSandbox(child: {
    readonly session: AgentRunSession<SubagentRunRecord>
    readonly context: AgentExecutionContext
    readonly execution: ExecutionRecord
    readonly thread: AgentThreadRecord
  }): OpenRunSandbox
  /** A sandbox teardown that outlives the child: the runner waits for it before it stops. */
  onDetachedTeardown(teardown: Promise<void>): void
  /** A child that failed: the runner reports it, once its end is recorded. */
  reportFailure?(error: unknown, run: AgentRunRecord, failure: AgentRunFailure): void
  /** Runs the child's preparation, which calls no model. Runs it once when absent. */
  prepare?<T>(prepare: () => Promise<T>, signal: AbortSignal): Promise<T>
}

/** What a child runs under: its parent turn's. */
export interface ChildParent {
  /** The runner's own stop: its process stopping, or its hold on the parent lost. */
  readonly signal: AbortSignal
  /** When the parent's lease runs out, which the child is claimed until. */
  leaseExpiresAt(): string
  /** Holds the child's lease beside its parent's, from now until the returned release. */
  holdLease(session: AgentRunSession<SubagentRunRecord>): Promise<() => void>
  /** The turn's mailbox, through which they talk. */
  readonly family: FamilyMailbox
}

interface RunningChild {
  readonly parentRunId: string
  /** Aborted when the parent's turn ends while the child still runs. */
  readonly ended: AbortController
  readonly done: Promise<void>
}

/**
 * Runs the children of a runner's turns. A child holds its own run, session, token and sandbox,
 * but no lease of its own: its parent's renewals renew it, and a runner that stops takes its
 * children with it. A child left running once its parent ended is ended when its lease lapses.
 */
export class ChildRunner {
  /** Children running here, by run id: a child already running is never started twice. */
  private readonly running = new Map<string, RunningChild>()
  /** Children holding one of the runner's slots, and those waiting for one, first come first. */
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly host: ChildRunnerHost) {}

  /** Run a child, in this process. It records the child's fate itself and never rejects. */
  start(run: SubagentRunRecord, parent: ChildParent): void {
    if (this.running.has(run.id)) return
    const ended = new AbortController()
    const done = this.run(run, parent, ended.signal).catch((error: unknown) => {
      console.error(`[SixbAgent] Subagent run '${run.id}' failed outside its run.`, error)
    })
    this.running.set(run.id, { parentRunId: run.parentRunId, ended, done })
    void done.finally(() => {
      this.running.delete(run.id)
      // Ended, paused or never claimed: the turn's waits read why.
      parent.family.finished(run.id)
    })
  }

  /**
   * Stop a parent's children still running here, and wait for them to record it. The parent's
   * lease, which renews theirs, must hold until this returns.
   */
  async stopChildrenOf(parentRunId: string): Promise<void> {
    const children = [...this.running.values()].filter((child) => child.parentRunId === parentRunId)
    for (const child of children) {
      child.ended.abort(new DOMException("The parent Agent run has ended.", "AbortError"))
    }
    await Promise.allSettled(children.map((child) => child.done))
  }

  /** Wait for every child running here, for a runner that stops. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((child) => child.done))
  }

  private async run(
    queuedRun: SubagentRunRecord,
    parent: ChildParent,
    parentEnded: AbortSignal
  ): Promise<void> {
    const stopped = AbortSignal.any([parent.signal, parentEnded])
    if (!(await this.takeSlot(stopped))) return
    try {
      const session = await this.host.claim(queuedRun, {
        leaseExpiresAt: parent.leaseExpiresAt(),
        stop: stopped,
      })
      if (session) await this.runClaimed(session, parent, stopped)
    } finally {
      this.releaseSlot()
    }
  }

  /** Wait for one of the runner's child slots: false once the child stops first. */
  private takeSlot(stopped: AbortSignal): Promise<boolean> {
    if (stopped.aborted) return Promise.resolve(false)
    if (this.active < this.host.capacity) {
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

  private async runClaimed(
    session: AgentRunSession<SubagentRunRecord>,
    parent: ChildParent,
    stopped: AbortSignal
  ): Promise<void> {
    const { signal } = parent
    const run = session.run
    // A child stops with its parent: cancelling the parent cancels it.
    const turnSignal = AbortSignal.any([stopped, session.cancelled])
    let environment: AgentExecutionEnvironment | null = null
    let runtime: AgentTurnRuntime | null = null
    let releaseLease: (() => void) | undefined
    const work: SubagentWork = {}

    try {
      releaseLease = await parent.holdLease(session)
      const prepare = () => this.prepare(session)
      const prepared = await (this.host.prepare
        ? this.host.prepare(prepare, turnSignal)
        : prepare())
      const { context, execution, thread, conversation, plan, history } = prepared
      await session.events.publishStarted(run)
      runtime = createAgentTurnRuntime({ signal: turnSignal })
      // A message its parent sent while it was queued is read at its first step. What a paused run
      // it continues never read is in its trigger already.
      const inbox = new SubagentInbox(parent.family.child(run.id), run)
      environment = await createSubagentEnvironment({
        session,
        openSandbox: this.host.openSandbox({ session, context, execution, thread }),
        context,
        plan,
        run,
        thread,
        conversation,
        frameworkTools: [createAskParentTool(inbox)],
        ...(execution.requestedBy === undefined ? {} : { requestedBy: execution.requestedBy }),
        history,
        signal: runtime.signal,
        onDetachedTeardown: (teardown) => this.host.onDetachedTeardown(teardown),
      })
      await runSubagent({
        history,
        inbox,
        context: environment.turnContext,
        plan,
        run,
        session,
        thread,
        runtime,
        work,
        runFiles: environment.runFiles,
      })
    } catch (error) {
      if (isLostExecution(error, signal)) return
      // Its end could not be recorded: it stays running until its lease lapses, and is then ended
      // as interrupted.
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
      // A runner that stops takes its turns' children with it, and nothing replays them.
      const interrupted = aborted && stoppedByWorker(turnSignal, signal)
      const finalized = await recordFate(
        session,
        aborted ? "cancelled" : "failed",
        interrupted ? interruptedError(run) : error,
        work.messages
      )
      if (finalized) {
        if (finalized.run.status === "failed") {
          this.host.reportFailure?.(error, finalized.run, finalized.failure)
        }
        await session.events.publishRunFinished(finalized.run)
      }
    } finally {
      releaseLease?.()
      await session.close()
      runtime?.dispose()
      await environment?.dispose()
    }
  }

  /** Everything a child needs before its first model call, read through its session. */
  private async prepare(session: AgentRunSession<SubagentRunRecord>) {
    const { run } = session
    const child = await session.context()
    if (child.kind !== "subagent") throw new Error(`[SixbAgent] Run '${run.id}' changed kind.`)
    const { parent, execution, thread } = child
    if (!parent || parent.kind !== "conversation" || !isActiveRun(parent)) {
      throw new DOMException("The parent Agent run is no longer active.", "AbortError")
    }
    if (
      !execution ||
      execution.source.type !== "execution" ||
      execution.source.executionId !== parent.executionId
    ) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgent] Subagent run '${run.id}' has invalid execution lineage.`,
        {
          details: { parentRunId: run.parentRunId, runId: run.id, executionId: run.executionId },
        }
      )
    }
    // The child works in its own thread, and publishes into its conversation's gallery.
    if (!thread) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgent] Subagent run '${run.id}' references missing thread '${run.threadId}'.`,
        { details: agentRunFailureDetails(run) }
      )
    }
    const runPlan = await session.plan()
    const configured = resolveRunPlan(runPlan, {
      model: await session.models.language(runPlan.model),
    })
    const plan = Object.freeze({ ...configured, model: prepareAgentModel(configured).model })
    const requester = agentRequester(execution.requestedBy, child.names)
    const context: AgentExecutionContext = {
      ...this.host.settings,
      ...(requester === undefined ? {} : { requester }),
      blobStorage: session.files,
    }
    const history = { messages: child.messages, ...(child.paused ? { paused: child.paused } : {}) }
    return { context, execution, thread, conversation: child.conversation, plan, history }
  }
}

function isActiveRun(run: AgentRunRecord): boolean {
  return run.status === "queued" || run.status === "running"
}
