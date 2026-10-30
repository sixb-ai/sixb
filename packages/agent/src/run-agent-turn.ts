import type { AgentMessage, AgentMessagePart } from "@sixb/core"
import {
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
  runModelLoop,
  toModelMessages,
} from "@sixb/core/internal/agents"
import { isAbortError } from "@sixb/core/internal/workers"
import {
  type AgentRunDiagnostic,
  type AgentRunFinishReason,
  type AgentRunRecord,
  type ConversationAgentRunRecord,
  coerceAgentRunFinishReason,
} from "@sixb/core/storage"
import { attachmentKey, toolResultAttachmentKey } from "./attachments"
import { throwIfExecutionLost } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { type ConversationReaders, conversationAuthors } from "./message-authors"
import { userMessageTimes } from "./message-times"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
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

  const { threadContext } = input
  const { attachmentContext } = context
  const sentTimes = userMessageTimes(threadContext.history, context.projectTimeZone)
  const authors = input.conversation
    ? conversationAuthors({
        conversation: input.conversation,
        messages: threadContext.retainedMessages,
      })
    : undefined
  const newestUserMessageId = threadContext.retainedMessages
    .filter((message) => message.role === "user")
    .at(-1)?.id

  const modelMessages = toModelMessages(threadContext.modelMessages, {
    // Who takes part, then when, then who wrote it: `<sixb_author>` stays the message's last tag.
    userMessageSuffix: (message) => {
      if (!message.id) return undefined

      const closing = [
        message.id === newestUserMessageId ? authors?.section : undefined,
        sentTimes.get(message.id),
        authors?.byMessageId.get(message.id),
      ]
      return closing.filter(Boolean).join("\n") || undefined
    },
    fileText: ({ message, partIndex }) =>
      message.id
        ? attachmentContext?.promptTextByPartKey.get(attachmentKey(message.id, partIndex))
        : undefined,
    fileData: ({ message, partIndex }) =>
      message.id
        ? attachmentContext?.modelFileDataByPartKey.get(attachmentKey(message.id, partIndex))
        : undefined,
    toolResultFileText: ({ message, partIndex, contentIndex }) =>
      message.id
        ? attachmentContext?.promptTextByPartKey.get(
            toolResultAttachmentKey(message.id, partIndex, contentIndex)
          )
        : undefined,
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

  try {
    let chunkIndex = 0
    let result: PausableModelLoopResult
    try {
      result = await runModelLoop({
        model: plan.model,
        messages: [
          {
            role: "system",
            content: context.systemPrompt,
          },
          ...modelMessages,
          ...(input.children?.waiting
            ? [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: input.children.waiting }],
                },
              ]
            : []),
        ],
        tools,
        ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
        ...(context.prepareStep === undefined ? {} : { prepareStep: context.prepareStep }),
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
      throw error
    }

    interruptedParts =
      result.status === "aborted"
        ? agentTraceFromPartialModelLoop(result.steps, result.partialContent, {
            threadId: run.threadId,
            runId,
          })
        : agentTraceFromModelSteps(result.steps, { threadId: run.threadId, runId })

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
