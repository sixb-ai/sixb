import type { AgentStepRequestSize } from "@sixb/core"
import {
  type AgentContextBudget,
  type AgentRunSession,
  createAgentMessageId,
  measureAgentStepRequest,
  type PausableModelLoopResult,
  type PrepareModelStepInput,
  type RecoverModelStepInput,
  runModelLoop,
} from "@sixb/core/internal/agents"
import { isAbortError } from "@sixb/core/internal/workers"
import { type ModelMessage, ModelProviderError, type ModelStep } from "@sixb/core/models"
import {
  type AgentRunDiagnostic,
  type AgentRunFinishReason,
  type AgentRunRecord,
  type AppendAgentMessageInput,
  type ConversationAgentRunRecord,
  coerceAgentRunFinishReason,
} from "@sixb/core/storage"
import { stepAskedUser } from "./ask-tool"
import { createAgentContextGuard } from "./context-guard"
import { conversationModelMessages, conversationModelSettings } from "./conversation-messages"
import {
  AgentContextCompactionError,
  AgentEnvironmentSaveError,
  throwIfExecutionLost,
  WORKSPACE_NOT_SAVED_DIAGNOSTIC,
} from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import type { ConversationReaders } from "./message-authors"
import type { ConversationAgentExecutionEnvironment } from "./run-environment"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { LoadedAgentThreadModelContext } from "./thread-context"
import { TurnInbox, turnResultMessages, turnWorkMessages } from "./turn-inbox"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

export interface RunAgentTurnInput {
  /** The worker's stable execution context (storage, tools and stream sink). */
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  /** The run this delivery reserved or reclaimed with its execution token. */
  readonly run: ConversationAgentRunRecord
  /** The run's session: its finish, and every other write, are fenced by its execution token. */
  readonly session: AgentRunSession
  /** The worker's shutdown signal. */
  readonly signal: AbortSignal
  /**
   * The worker's own stop, when `signal` also carries a user cancel. A turn it ends first is
   * recorded with `finishReason: "interrupted"` so the user can resume it.
   */
  readonly stopSignal?: AbortSignal
  /** Shared with preflight when this turn performed compaction. */
  readonly runtime?: AgentTurnRuntime
  /** The thread and who can read it now; without it the model is told nothing of its people. */
  readonly conversation?: ConversationReaders
  /** The history the turn runs on: as it started, or as its compaction left it. */
  readonly threadContext: LoadedAgentThreadModelContext
  /** What the turn's children ask it, and the work it waits for, when it can delegate. */
  readonly children?: TurnChildren
  /**
   * The model's limit every call of the turn keeps under (see createAgentContextGuard), and how
   * it compacts the history before it from within. Without them, only the turn's start was
   * weighed.
   */
  readonly contextLimits?: {
    readonly budget: AgentContextBudget
    /** The bytes per token the turn's history was measured at, else its run's starting one. */
    readonly bytesPerToken?: number
    /** What the run's latest counted call measured (see prepareAgentModel). */
    readonly measuredBytesPerToken?: () => number | undefined
    readonly compactInTurn?: ConversationAgentExecutionEnvironment["compactInTurn"]
  }
  /**
   * Handed the answer so far after each step that completed, as the messages the turn would
   * append: a turn that fails then records them with its failure, and keeps that work.
   */
  readonly onWork?: (messages: readonly AppendAgentMessageInput[]) => void
}

/**
 * How a turn hears the questions its children ask, leaves them waiting when it ends, and waits for
 * those still at work when it pauses.
 */
export interface TurnChildren {
  /** Read after the conversation: children of earlier turns still waiting on their question. */
  readonly waiting?: string
  /** The questions the model has not read yet, read in one more step when it answers. */
  unread(): Promise<string | undefined>
  /**
   * Before the turn records its end: each child still waiting on its question pauses on it, and
   * the turn waits until it has. Only then can its end cancel the others.
   */
  defer(signal: AbortSignal): Promise<void>
  /**
   * Before a pausing turn records its end: wait until none of its children is at work. Its end
   * cancels those still at work; one that holds a call pauses by itself.
   */
  settle(signal: AbortSignal): Promise<void>
}

/** Drive one provider-neutral model/tool turn to completion and persist it. */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentRunRecord> {
  const { context, plan, run, signal } = input
  const { id: projectId, tools } = context
  const runId = run.id

  const modelMessages = conversationModelMessages({
    threadContext: input.threadContext,
    ...(context.attachmentContext ? { attachmentContext: context.attachmentContext } : {}),
    ...(input.conversation ? { conversation: input.conversation } : {}),
    project: { timeZone: context.projectTimeZone, locale: context.projectLocale },
  })

  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  // Preflight and the answer share one signal. Direct callers own their runtime.
  const ownsRuntime = input.runtime === undefined
  const runtime = input.runtime ?? createAgentTurnRuntime({ signal })
  const abortSignal = AbortSignal.any([
    runtime.signal,
    sandboxReadiness.signal,
    ...(context.environmentFailureSignal ? [context.environmentFailureSignal] : []),
  ])
  let interruptedMessages: readonly AppendAgentMessageInput[] | undefined
  const stopReason = () =>
    stoppedByWorker(signal, input.stopSignal) ? { finishReason: "interrupted" as const } : {}

  const finalizeIfInterrupted = async (error?: unknown): Promise<AgentRunRecord | null> => {
    throwIfExecutionLost(runtime.sourceSignal)
    sandboxReadiness.throwIfFailed()
    context.environmentFailureSignal?.throwIfAborted()
    if (!abortSignal.aborted && (error === undefined || !isAbortError(error))) return null
    return finalizeInterruptedTurn({
      session: input.session,
      context,
      run,
      modelId: plan.model.modelId,
      ...stopReason(),
      messages: interruptedMessages,
    })
  }

  // What every request starts with: the system prompt, the conversation, then what children of
  // earlier turns still wait on.
  const requestHead = (systemPrompt: string, conversation: readonly ModelMessage[]) => [
    { role: "system" as const, content: systemPrompt },
    ...conversation,
    ...(input.children?.waiting
      ? [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: input.children.waiting }],
          },
        ]
      : []),
  ]
  // What each step's request carried, as it was sent, for its step-start to record. The prompt's
  // sections are known for the prompt the turn rendered, then for the one its compaction rendered.
  const stepRequests: AgentStepRequestSize[] = []
  let systemPromptSize = context.systemPromptSize
  const recordRequest = (stepIndex: number, messages: readonly ModelMessage[]) => {
    stepRequests[stepIndex] = measureAgentStepRequest({
      messages,
      tools,
      ...(systemPromptSize ? { systemPrompt: systemPromptSize } : {}),
      ...(context.contextDirectory === undefined
        ? {}
        : { contextDirectory: context.contextDirectory }),
    })
  }

  const limits = input.contextLimits
  const compactInTurn = limits?.compactInTurn
  const guard =
    limits &&
    createAgentContextGuard({
      budget: limits.budget,
      ...(limits.bytesPerToken === undefined ? {} : { bytesPerToken: limits.bytesPerToken }),
      ...(limits.measuredBytesPerToken === undefined
        ? {}
        : { measuredBytesPerToken: limits.measuredBytesPerToken }),
      ...(context.onReadCut === undefined ? {} : { onReadCut: context.onReadCut }),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      ...(compactInTurn
        ? {
            compact: async (compaction) => {
              const request = await compactInTurn(compaction)
              if (request) systemPromptSize = request.systemPromptSize
              return request && requestHead(request.systemPrompt, request.messages)
            },
          }
        : {}),
    })
  const guardedStep = guard
    ? async (step: Parameters<typeof guard.prepareStep>[0]) => {
        const prepared = await context.prepareStep?.(step)
        const guarded = await guard.prepareStep({
          ...step,
          messages: prepared?.messages ?? step.messages,
        })
        // The guard's request, when it reduced the one prepared, and the room its answer has.
        return { ...prepared, ...guarded }
      }
    : context.prepareStep
  const turnInbox = new TurnInbox(input.session, {
    retainedMessages: input.threadContext.retainedMessages,
    ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
    project: { timeZone: context.projectTimeZone, locale: context.projectLocale },
  })
  const prepareStep = async (step: PrepareModelStepInput) => {
    const prepared = await guardedStep?.(step)
    const steers = await turnInbox.take(step.stepIndex)
    const baseMessages = prepared?.messages ?? step.messages
    const nextMessages = steers.length > 0 ? [...baseMessages, ...steers] : baseMessages
    recordRequest(step.stepIndex, nextMessages)
    if (steers.length === 0) return prepared
    return { ...prepared, messages: nextMessages }
  }
  const recoverStep =
    guard &&
    (async (step: RecoverModelStepInput) => {
      const recovered = await guard.recoverStep(step)
      if (recovered?.messages) recordRequest(step.stepIndex, recovered.messages)
      return recovered
    })

  const finishedSteps: ModelStep[] = []
  const recordStep = (step: ModelStep) => {
    finishedSteps.push(step)
    const snapshot = turnWorkMessages({
      steps: finishedSteps,
      run,
      deliveries: turnInbox.deliveries,
      ...(guard?.reducedFromStep() === undefined
        ? {}
        : { reducedFromStep: guard.reducedFromStep() }),
      stepRequests,
      ...(context.outputFileOf === undefined ? {} : { outputFileOf: context.outputFileOf }),
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
    })
    interruptedMessages = snapshot
    input.onWork?.(snapshot)
  }

  try {
    let chunkIndex = 0
    let result: PausableModelLoopResult
    let askedUser = false
    try {
      result = await runModelLoop({
        model: plan.model,
        messages: requestHead(context.systemPrompt, modelMessages),
        tools,
        ...conversationModelSettings({
          reasoning: plan.reasoning,
          projectId,
          threadId: run.threadId,
        }),
        ...(plan.maxSteps === undefined ? {} : { maxSteps: plan.maxSteps }),
        prepareStep,
        ...(recoverStep ? { recoverStep } : {}),
        onStepEnd: recordStep,
        // Mid-run steers and unread child questions arrive before the answer ends the turn.
        beforeComplete: async (_step, stepIndex) => {
          const steers = await turnInbox.take(stepIndex + 1, { afterAnswer: true })
          const unread = await input.children?.unread()
          const followUp: ModelMessage[] = [
            ...steers,
            ...(unread
              ? [{ role: "user" as const, content: [{ type: "text" as const, text: unread }] }]
              : []),
          ]
          return followUp.length > 0 ? followUp : undefined
        },
        signal: abortSignal,
        onEvent: async (chunk) => {
          await input.session.events.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })
        },
        // The approval records decide, never the tool output: the model can send a command's
        // output elsewhere, or print one of its own. A held call waits for the children still
        // at work: pausing ends the turn, and that would cancel them. A question to the user ends
        // the turn too: the answer is the user's next message.
        pauseAfterStep: async (step) => {
          if (stepAskedUser(step)) askedUser = true
          return (await input.session.heldCalls.pausesAfterStep()) || askedUser
        },
      })
    } catch (error) {
      const interrupted = await finalizeIfInterrupted(error)
      if (interrupted) return interrupted

      // Compacted and asked again, the request still did not fit the model's window.
      if (error instanceof ModelProviderError && error.reason === "context-window-exceeded") {
        throw new AgentContextCompactionError(
          "context_limit_exceeded",
          runId,
          "The conversation still exceeds the model's context window after it was reduced. Start a new conversation or select a model with a larger context window.",
          { cause: error }
        )
      }
      throw error
    }

    interruptedMessages = turnResultMessages(result, {
      run,
      deliveries: turnInbox.deliveries,
      ...(guard?.reducedFromStep() === undefined
        ? {}
        : { reducedFromStep: guard.reducedFromStep() }),
      stepRequests,
      ...(context.outputFileOf === undefined ? {} : { outputFileOf: context.outputFileOf }),
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
    })

    const interruptedAfterModel = await finalizeIfInterrupted()
    if (interruptedAfterModel) return interruptedAfterModel
    if (result.status === "aborted") {
      return finalizeInterruptedTurn({
        session: input.session,
        context,
        run,
        modelId: plan.model.modelId,
        ...stopReason(),
        messages: interruptedMessages,
      })
    }

    // A child waiting on its question pauses on it while the turn still runs: a waiting child
    // would hold the wait below forever, and the turn's end cancels the children still at work.
    await input.children?.defer(abortSignal)

    // A call held after the last step that ran tools, by a command left running in the sandbox or
    // by a child, pauses the turn too. Its end cancels the children still at work, so it first
    // waits for them: one that holds a call pauses by itself instead of being stopped.
    if (result.status === "paused" || (await input.session.heldCalls.holdsRun())) {
      await input.children?.settle(abortSignal)
    }
    const interruptedWhileWaiting = await finalizeIfInterrupted()
    if (interruptedWhileWaiting) return interruptedWhileWaiting

    // A turn that stopped on its question alone simply ends: nothing waits for a decision.
    const held = await input.session.heldCalls.holdsRun()
    const finishReason =
      held || (result.status === "paused" && !askedUser)
        ? "awaiting_approval"
        : result.status === "paused"
          ? "stop"
          : (coerceAgentRunFinishReason(result.finishReason) ?? "unknown")
    const diagnostics = [
      outputLimitDiagnostic(finishReason),
      finishReason === "awaiting_approval" ? undefined : stepLimitDiagnostic(result),
    ].filter((diagnostic) => diagnostic !== undefined)
    const committedMessages: readonly AppendAgentMessageInput[] =
      interruptedMessages !== undefined && interruptedMessages.length > 0
        ? interruptedMessages
        : [
            {
              id: createAgentMessageId(),
              projectId,
              threadId: run.threadId,
              runId,
              role: "assistant" as const,
              parts: [],
              ...(context.authorPrincipal === undefined
                ? {}
                : { authorPrincipal: context.authorPrincipal }),
            },
          ]
    const lastAssistant = [...committedMessages]
      .reverse()
      .find((message) => message.role === "assistant")

    const interruptedBeforeCommit = await finalizeIfInterrupted()
    if (interruptedBeforeCommit) return interruptedBeforeCommit

    const unsaved = await saveWorkspace(context)
    if (unsaved) diagnostics.push(unsaved)
    const finalizedRun = await input.session.finish(
      {
        status: "succeeded",
        modelId: plan.model.modelId,
        finishReason,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
      },
      committedMessages
    )

    if (lastAssistant) {
      await input.session.events.publishMessageFinalized({ run, messageId: lastAssistant.id })
    }
    await input.session.events.publishRunFinished(finalizedRun)
    return finalizedRun
  } finally {
    if (ownsRuntime) runtime.dispose()
  }
}

/**
 * Whether the turn holds a call for its requester, as `runs.finish` checks before it pauses: one
 * waiting, or decided and not reported to the model yet, its children's included.
 */

/**
 * Save the turn's workspace before its terminal write. One that could not be saved waits for
 * recovery, and the turn ends as it would have, with a diagnostic that says so: the answer, or the
 * stop, is what happened.
 */
async function saveWorkspace(context: AgentTurnContext): Promise<AgentRunDiagnostic | undefined> {
  try {
    await context.beforeFinalize?.()
    return undefined
  } catch (error) {
    if (error instanceof AgentEnvironmentSaveError) return WORKSPACE_NOT_SAVED_DIAGNOSTIC
    throw error
  }
}

/**
 * Whether the worker's stop, rather than the user's, ended the turn. Whichever fired first wins:
 * the combined turn signal carries the reason of the first source that aborted it.
 */
export function stoppedByWorker(turnSignal: AbortSignal, stopSignal?: AbortSignal): boolean {
  return stopSignal?.aborted === true && turnSignal.reason === stopSignal.reason
}

/**
 * An answer the output limit cut short keeps what the model produced, reasoning included, and says
 * so through a diagnostic, which chats render in the reader's language. Its unfinished tool calls
 * were dropped unexecuted.
 */
function outputLimitDiagnostic(finishReason: AgentRunFinishReason): AgentRunDiagnostic | undefined {
  if (finishReason !== "length") return undefined
  return {
    code: "output_limit_reached",
    severity: "warning",
    scope: "run",
    message: "The model reached its output limit before finishing the answer.",
  }
}

/**
 * A turn the project's `maxSteps` stopped keeps its work as its answer, and says so: Continue starts
 * a turn that goes on from it, as a retry would only stop at the same place.
 */
function stepLimitDiagnostic(result: PausableModelLoopResult): AgentRunDiagnostic | undefined {
  if (result.status !== "completed" || !result.stepLimitReached) return undefined
  return {
    code: "step_limit_reached",
    severity: "warning",
    scope: "run",
    message: "The agent reached its step limit before producing a final answer.",
  }
}

/** Persist a cancelled turn, retaining coherent partial content when any was produced. */
async function finalizeInterruptedTurn(input: {
  readonly session: AgentRunSession
  readonly context: AgentTurnContext
  readonly run: ConversationAgentRunRecord
  readonly modelId?: string
  readonly finishReason?: "interrupted"
  readonly messages?: readonly AppendAgentMessageInput[]
}): Promise<AgentRunRecord> {
  const { session, context, run, modelId, finishReason } = input
  const messages = input.messages && input.messages.length > 0 ? input.messages : undefined

  const unsaved = await saveWorkspace(context)

  const outcome = {
    status: "cancelled" as const,
    ...(modelId === undefined ? {} : { modelId }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(unsaved === undefined ? {} : { diagnostics: [unsaved] }),
  }
  if (!messages) {
    const finalizedRun = await session.finish(outcome)
    await session.events.publishRunFinished(finalizedRun)
    return finalizedRun
  }

  const finalizedRun = await session.finish(outcome, messages)
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
  if (lastAssistant) {
    await session.events.publishMessageFinalized({ run, messageId: lastAssistant.id })
  }
  await session.events.publishRunFinished(finalizedRun)
  return finalizedRun
}
