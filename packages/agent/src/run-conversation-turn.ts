import { principalsEqual } from "@sixb/core"
import {
  AgentExecutionLostError,
  AgentFinalizationError,
  type AgentRunSession,
  AgentTurnInterruptedError,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { ModelUsageRecordingError } from "@sixb/core/internal/model-execution"
import { isAbortError } from "@sixb/core/internal/workers"
import type {
  AgentRunRecord,
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  AppendAgentMessageInput,
  ConversationAgentRunRecord,
  ExecutionRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import {
  expectedRemainingAgentCalls,
  prepareAgentModel,
  resolveAgentContextTarget,
} from "./context-budget"
import { AgentEnvironmentSaveError, AgentRequesterLeftThreadError, isLostExecution } from "./errors"
import { resolveRunPlan } from "./execution-plan"
import type { AgentRunFailure } from "./failure"
import type { FamilyMailbox } from "./family-mailbox"
import { agentRequester } from "./requester"
import { runAgentTurn, stoppedByWorker } from "./run-agent-turn"
import {
  type ConversationAgentExecutionEnvironment,
  createConversationAgentEnvironment,
  type OpenRunSandbox,
} from "./run-environment"
import { recordFate } from "./run-fate"
import { SubagentCoordinator } from "./subagent-tools"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentExecutionContext, AgentRunSettings } from "./types"

// A conversation turn, from its claimed session to its end, whichever runner runs it: the worker,
// under a queue delivery, or a runner on a computer, over HTTP. The runner keeps what is its own:
// how it holds the run, where the turn's sandbox comes from, and where its children run.

/** What a runner lends the turns it runs. */
export interface ConversationTurnRunner {
  /** What every run of the project shares. */
  readonly settings: AgentRunSettings
  /** The sandbox the turn works in, opened when it first needs one. */
  openSandbox(turn: {
    readonly session: AgentRunSession<ConversationAgentRunRecord>
    readonly context: AgentExecutionContext
    readonly execution: ExecutionRecord
    readonly thread: AgentThreadRecord | null
  }): OpenRunSandbox
  /** Run a child the turn spawned or continues, beside the turn, on the turn's mailbox. */
  startChild(run: SubagentRunRecord, family: FamilyMailbox): void
  /** A sandbox teardown that outlives the turn: the runner waits for it before it stops. */
  onDetachedTeardown(teardown: Promise<void>): void
  /** A turn that failed: the runner reports it, once its end is recorded. */
  reportFailure?(error: unknown, run: AgentRunRecord, failure: AgentRunFailure): void
  /**
   * Runs the turn's preparation, which reads and resolves and calls no model: the worker retries a
   * storage blip in place. Runs it once when absent.
   */
  prepare?<T>(prepare: () => Promise<T>): Promise<T>
}

/**
 * Run a claimed conversation turn and record how it ended. Returns once its end is recorded, or
 * at once when its runner lost the run. Throws {@link AgentFinalizationError} when its end could
 * not be recorded, and rethrows its failure when `signal` stopped it, for the runner to release
 * the run rather than call it done.
 */
export async function runConversationTurn(input: {
  readonly session: AgentRunSession<ConversationAgentRunRecord>
  readonly runner: ConversationTurnRunner
  /** The runner's own stop: its process stopping, or its hold on the run lost. */
  readonly signal: AbortSignal
}): Promise<void> {
  const { session, runner, signal } = input
  const { run } = session
  let environment: ConversationAgentExecutionEnvironment | null = null
  let runtime: AgentTurnRuntime | null = null
  let delegation: SubagentCoordinator | undefined
  // The answer so far: a turn that fails keeps the steps it completed.
  let work: AppendAgentMessageInput | undefined
  // A user cancel joins the turn's abort sources, so it stops the model stream as a shutdown does.
  const turnSignal = AbortSignal.any([signal, session.cancelled])

  try {
    const prepare = () => prepareConversationTurn(session, runner.settings)
    const prepared = await (runner.prepare ? runner.prepare(prepare) : prepare())
    const plan = Object.freeze({ ...prepared.plan, model: prepared.model.model })

    await session.events.publishStarted(run)
    runtime = createAgentTurnRuntime({ signal: turnSignal })
    delegation = new SubagentCoordinator(
      prepared.delegation,
      runner.settings,
      run,
      session,
      (child, family) => runner.startChild(child, family)
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
      openSandbox: runner.openSandbox({
        session,
        context: prepared.context,
        execution: prepared.execution,
        thread: prepared.thread,
      }),
      preflight: { budget: prepared.model.budget, runtime },
      context: prepared.context,
      plan,
      run,
      history: prepared.history,
      signal: runtime.signal,
      onDetachedTeardown: (teardown) => runner.onDetachedTeardown(teardown),
    })
    delegation.attach(environment.runFiles)
    // A resumed turn's paused children go on first, as the model reads that they do.
    await delegation.continuePausedChildren(runtime.signal)
    runtime.assertCanContinue()
    await runAgentTurn({
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
      contextLimits: {
        budget: prepared.model.budget,
        targetTokens: resolveAgentContextTarget(prepared.model.budget, {
          expectedRemainingCalls: expectedRemainingAgentCalls(prepared.history),
        }).tokens,
        ...(environment.compactInTurn ? { compactInTurn: environment.compactInTurn } : {}),
        ...(environment.bytesPerToken === undefined
          ? {}
          : { bytesPerToken: environment.bytesPerToken }),
      },
      onWork: (message) => {
        work = message
      },
    })
  } catch (caughtError) {
    let error = caughtError
    let environmentSaveFailed = error instanceof AgentEnvironmentSaveError
    // Its runner lost the run: touch nothing; whoever holds it now ends it.
    if (isLostExecution(error, signal)) return
    // It ended, but its end could not be recorded (storage down): its runner tries again.
    if (error instanceof AgentFinalizationError) throw error
    if (environment) {
      try {
        await environment.beforeFinalize()
      } catch (saveError) {
        if (saveError instanceof AgentExecutionLostError) return
        error = saveError
        environmentSaveFailed = true
      }
    }
    // A user cancel is read off its own signal, so it records `cancelled` however the aborted
    // stream surfaced. `recordFate` retries a blip, and throws AgentFinalizationError past it.
    const aborted =
      error instanceof AgentRequesterLeftThreadError ||
      (!environmentSaveFailed &&
        !(error instanceof ModelUsageRecordingError) &&
        (signal.aborted || session.cancelled.aborted || isAbortError(error)))
    // A runner that stops, unlike a user cancel, leaves the user something to resume.
    const interrupted = aborted && stoppedByWorker(turnSignal, signal)
    const finalized = await recordFate(
      session,
      aborted ? "cancelled" : "failed",
      interrupted ? new AgentTurnInterruptedError(run.id) : error,
      !aborted && work ? [work] : undefined
    )
    if (finalized) {
      if (finalized.run.status === "failed") {
        runner.reportFailure?.(error, finalized.run, finalized.failure)
      }
      await session.events.publishRunFinished(finalized.run)
    }
    // Its runner stopped: it releases the run rather than calls it done.
    if (signal.aborted) throw error
  } finally {
    delegation?.close()
    runtime?.dispose()
    await environment?.dispose()
  }
}

/** Everything a turn needs before its first model call, read through its session. */
async function prepareConversationTurn(
  session: AgentRunSession<ConversationAgentRunRecord>,
  settings: AgentRunSettings
) {
  const { run } = session
  const turn = await session.context()
  const { thread, execution, participants } = turn
  const runPlan = await session.plan()
  const plan = resolveRunPlan(runPlan, { model: await session.models.language(runPlan.model) })
  // A turn's plan always carries it; only a child's goes without.
  if (!runPlan.delegation) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgent] Agent run '${run.id}' has no models to delegate to.`
    )
  }
  if (!execution) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgent] Agent run '${run.id}' references missing execution '${run.executionId}'.`,
      { details: { runId: run.id, threadId: run.threadId, executionId: run.executionId } }
    )
  }
  assertRequesterTakesPart(run, thread, participants, execution)

  const conversation = thread
    ? { thread, participants: turn.readers, names: turn.names }
    : undefined
  // The rule run tokens apply to memory: someone who loses access may regain it, and read back
  // whatever memory the thread held meanwhile.
  const shared = participants.length > 0
  // A shared thread's system prompt names nobody, so it stays the same whoever sends the turn.
  const requester =
    (conversation?.participants.length ?? 0) > 0
      ? undefined
      : agentRequester(execution.requestedBy, turn.names)
  const context: AgentExecutionContext = {
    ...settings,
    ...(requester === undefined ? {} : { requester }),
    blobStorage: session.files,
  }
  return {
    thread,
    ...(conversation === undefined ? {} : { conversation }),
    shared,
    plan,
    delegation: {
      models: runPlan.delegation,
      toolNames: runPlan.tools.map((tool) => tool.name),
    },
    execution,
    context,
    model: prepareAgentModel(plan),
    history: turn.history,
  }
}

/**
 * A shared thread's turn waits queued: its requester may leave the thread, or be removed, before
 * it starts. Such a turn never reaches the model. One already running when they leave finishes,
 * as it already read the thread.
 */
function assertRequesterTakesPart(
  run: ConversationAgentRunRecord,
  thread: AgentThreadRecord | null,
  participants: readonly AgentThreadParticipantRecord[],
  execution: ExecutionRecord
): void {
  const requester = execution.requestedBy
  if (!thread || !requester || principalsEqual(requester, thread.ownerPrincipal)) return
  if (participants.some((participant) => principalsEqual(participant.principal, requester))) return

  throw new AgentRequesterLeftThreadError(run.id)
}
