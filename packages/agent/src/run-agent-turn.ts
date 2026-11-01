import type { AgentMessage, AgentMessagePart } from "@sixb/core"
import {
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
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
import type { AgentContextBudget } from "./context-budget"
import { createAgentContextGuard } from "./context-guard"
import { conversationModelMessages, conversationModelSettings } from "./conversation-messages"
import { AgentContextCompactionError, throwIfExecutionLost } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import type { ConversationReaders } from "./message-authors"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import type { ConversationAgentExecutionEnvironment } from "./run-environment"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { LoadedAgentThreadModelContext } from "./thread-context"
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
   * Handed the answer so far after each step that completed, as the message the turn would
   * append: a turn that fails then records it with its failure, and keeps that work.
   */
  readonly onWork?: (message: AppendAgentMessageInput) => void
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
  let interruptedParts: readonly AgentMessagePart[] | undefined
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
      parts: interruptedParts,
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
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      ...(compactInTurn
        ? {
            compact: async (compaction) => {
              const request = await compactInTurn(compaction)
              return request && requestHead(request.systemPrompt, request.messages)
            },
          }
        : {}),
    })
  const prepareStep = guard
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

  // The answer so far, as one message whatever step it is at.
  const workMessageId = createAgentMessageId()
  const finishedSteps: ModelStep[] = []
  const recordStep = (step: ModelStep) => {
    finishedSteps.push(step)
    input.onWork?.({
      id: workMessageId,
      projectId,
      threadId: run.threadId,
      runId,
      role: "assistant",
      parts: markReducedSteps(
        agentTraceFromModelSteps(
          finishedSteps,
          { threadId: run.threadId, runId },
          context.outputFileOf
        ),
        guard?.reducedFromStep()
      ),
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
    })
  }

  try {
    let chunkIndex = 0
    let result: PausableModelLoopResult
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
        ...(prepareStep === undefined ? {} : { prepareStep }),
        ...(guard ? { recoverStep: guard.recoverStep } : {}),
        onStepEnd: recordStep,
        // A child's question the model has not read comes before its answer ends the turn.
        ...(input.children === undefined
          ? {}
          : {
              beforeComplete: async () => {
                const unread = await input.children?.unread()
                return unread
                  ? [{ role: "user", content: [{ type: "text", text: unread }] }]
                  : undefined
              },
            }),
        signal: abortSignal,
        onEvent: async (chunk) => {
          await input.session.events.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })
        },
        // The approval records decide, never the tool output: the model can send a command's
        // output elsewhere, or print one of its own. A held call waits for the children still
        // at work: pausing ends the turn, and that would cancel them.
        pauseAfterStep: () => input.session.heldCalls.pausesAfterStep(),
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

    interruptedParts = markReducedSteps(
      result.status === "aborted"
        ? agentTraceFromPartialModelLoop(
            result.steps,
            result.partialContent,
            { threadId: run.threadId, runId },
            context.outputFileOf
          )
        : agentTraceFromModelSteps(
            result.steps,
            { threadId: run.threadId, runId },
            context.outputFileOf
          ),
      guard?.reducedFromStep()
    )

    const interruptedAfterModel = await finalizeIfInterrupted()
    if (interruptedAfterModel) return interruptedAfterModel
    if (result.status === "aborted") {
      return finalizeInterruptedTurn({
        session: input.session,
        context,
        run,
        modelId: plan.model.modelId,
        ...stopReason(),
        parts: interruptedParts,
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

    const finishReason =
      result.status === "paused" || (await input.session.heldCalls.holdsRun())
        ? "awaiting_approval"
        : (coerceAgentRunFinishReason(result.finishReason) ?? "unknown")
    const assistant: AgentMessage = { role: "assistant", parts: interruptedParts }
    const diagnostics = [outputLimitDiagnostic(finishReason)].filter(
      (diagnostic) => diagnostic !== undefined
    )
    const assistantMessageId = createAgentMessageId()

    const interruptedBeforeCommit = await finalizeIfInterrupted()
    if (interruptedBeforeCommit) return interruptedBeforeCommit

    await context.beforeFinalize?.()
    const finalizedRun = await input.session.finish(
      {
        status: "succeeded",
        modelId: plan.model.modelId,
        finishReason,
        ...(diagnostics.length === 0 ? {} : { diagnostics }),
      },
      [
        {
          id: assistantMessageId,
          projectId,
          threadId: run.threadId,
          runId,
          role: assistant.role,
          parts: assistant.parts,
          ...(context.authorPrincipal === undefined
            ? {}
            : { authorPrincipal: context.authorPrincipal }),
        },
      ]
    )

    await input.session.events.publishMessageFinalized({ run, messageId: assistantMessageId })
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
 * Mark each step from `fromStep` on as answering a request the turn reduced, for the next turn's
 * estimate not to go by what those calls read.
 */
export function markReducedSteps(
  parts: readonly AgentMessagePart[],
  fromStep: number | undefined
): readonly AgentMessagePart[] {
  if (fromStep === undefined) return parts

  let step = -1
  return parts.map((part) => {
    if (part.type !== "step-start") return part

    step += 1
    return step >= fromStep ? { type: "step-start", reducedRequest: true } : part
  })
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

/** Persist a cancelled turn, retaining coherent partial content when any was produced. */
async function finalizeInterruptedTurn(input: {
  readonly session: AgentRunSession
  readonly context: AgentTurnContext
  readonly run: ConversationAgentRunRecord
  readonly modelId?: string
  readonly finishReason?: "interrupted"
  readonly parts?: readonly AgentMessagePart[]
}): Promise<AgentRunRecord> {
  const { session, context, run, modelId, finishReason } = input
  const parts = input.parts?.some((part) => part.type !== "step-start") ? input.parts : undefined

  await context.beforeFinalize?.()

  const outcome = {
    status: "cancelled" as const,
    ...(modelId === undefined ? {} : { modelId }),
    ...(finishReason === undefined ? {} : { finishReason }),
  }
  if (!parts) {
    const finalizedRun = await session.finish(outcome)
    await session.events.publishRunFinished(finalizedRun)
    return finalizedRun
  }

  const assistantMessageId = createAgentMessageId()
  const finalizedRun = await session.finish(outcome, [
    {
      id: assistantMessageId,
      projectId: run.projectId,
      threadId: run.threadId,
      runId: run.id,
      role: "assistant",
      parts,
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
    },
  ])
  await session.events.publishMessageFinalized({ run, messageId: assistantMessageId })
  await session.events.publishRunFinished(finalizedRun)
  return finalizedRun
}
