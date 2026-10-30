import type { AgentMessage, AgentMessagePart } from "@sixb/core"
import {
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
  runModelLoop,
  toModelMessages,
  turnPausesOnHeldCalls,
} from "@sixb/core/internal/agents"
import { isAbortError, QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import {
  type AgentRunDiagnostic,
  type AgentRunFinishReason,
  type AgentRunRecord,
  type AgentStorage,
  type ConversationAgentRunRecord,
  coerceAgentRunFinishReason,
} from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION } from "./agent-prompt"
import { attachmentKey, toolResultAttachmentKey } from "./attachments"
import { AgentTurnTimeoutError } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { type AgentRunFailure, toAgentExecutionFailure } from "./failure"
import { type ConversationReaders, loadConversationAuthors } from "./message-authors"
import { loadUserMessageTimes } from "./message-times"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import { type LoadedAgentThreadModelContext, loadAgentThreadModelContext } from "./thread-context"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

export const DEFAULT_MAX_STEPS = 100

export interface RunAgentTurnInput {
  /** The worker's stable execution context (storage, tools, stream sink, and turn limits). */
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
  /** Preflight's retained projection, avoiding a second storage read in the worker path. */
  readonly threadContext?: LoadedAgentThreadModelContext
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
   * the turn waits until it has, until `stopAt`. Only then can its end cancel the others.
   */
  defer(stopAt: number, signal: AbortSignal): Promise<void>
  /**
   * Before a pausing turn records its end: wait until none of its children is at work, or until
   * `stopAt`. Its end cancels those still at work; one that holds a call pauses by itself.
   */
  settle(stopAt: number, signal: AbortSignal): Promise<void>
}

/** Drive one provider-neutral model/tool turn to completion and persist it. */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentRunRecord> {
  const { context, plan, run, signal } = input
  const { id: projectId, storage, tools, turnTimeoutMs } = context
  const runId = run.id
  const agents = storage.agents

  const threadContext =
    input.threadContext ??
    (await loadAgentThreadModelContext({
      storage: agents,
      projectId,
      threadId: run.threadId,
    }))
  const { attachmentContext } = context
  const [sentTimes, authors] = await Promise.all([
    loadUserMessageTimes({
      storage: agents,
      projectId,
      threadId: run.threadId,
      messages: threadContext.retainedMessages,
      projectTimeZone: context.projectTimeZone,
    }),
    input.conversation
      ? loadConversationAuthors({
          auth: storage.auth,
          conversation: input.conversation,
          messages: threadContext.retainedMessages,
        })
      : undefined,
  ])
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

  const maxSteps = plan.maxSteps
  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  // Preflight and the answer share accounting and one deadline. Direct callers own their runtime.
  const ownsRuntime = input.runtime === undefined
  let runtime = input.runtime
  if (!runtime) {
    runtime = createAgentTurnRuntime({
      context,
      run,
      signal,
      modelCalls: await input.session.modelCalls(),
    })
  }
  const usageRecorder = runtime.usageRecorder
  const abortSignal = AbortSignal.any([
    runtime.signal,
    sandboxReadiness.signal,
    ...(context.environmentFailureSignal ? [context.environmentFailureSignal] : []),
  ])
  let interruptedParts: readonly AgentMessagePart[] | undefined
  const stopReason = () =>
    stoppedByWorker(signal, input.stopSignal) ? { finishReason: "interrupted" as const } : {}

  const finalizeIfInterrupted = async (error?: unknown): Promise<AgentRunRecord | null> => {
    if (runtime.sourceSignal.reason instanceof QueueDeliveryLeaseLostError) {
      throw runtime.sourceSignal.reason
    }
    usageRecorder.assertHealthy()
    sandboxReadiness.throwIfFailed()
    context.environmentFailureSignal?.throwIfAborted()
    if (runtime.timedOut()) {
      const completedAt = new Date()
      return finalizeInterruptedTurn({
        session: input.session,
        context,
        run,
        modelId: plan.model.modelId,
        status: "failed",
        finishReason: "timeout",
        error: toAgentExecutionFailure(new AgentTurnTimeoutError(runId, turnTimeoutMs), {
          status: "failed",
          at: completedAt,
          details: {
            runId,
            threadId: run.threadId,
            timeoutMs: String(turnTimeoutMs),
          },
        }),
        completedAt,
        parts: interruptedParts,
      })
    }
    if (!abortSignal.aborted && (error === undefined || !isAbortError(error))) return null
    return finalizeInterruptedTurn({
      session: input.session,
      context,
      run,
      modelId: plan.model.modelId,
      status: "cancelled",
      ...stopReason(),
      parts: interruptedParts,
    })
  }

  try {
    let chunkIndex = 0
    let result: PausableModelLoopResult
    try {
      result = await runModelLoop({
        model: usageRecorder.wrapModel(plan.model),
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
        maxSteps,
        finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
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
        onModelCallEnd: usageRecorder.onModelCallEnd,
        onEvent: async (chunk) => {
          await context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })
        },
        // The approval records decide, never the tool output: the model can send a command's
        // output elsewhere, or print one of its own. A held call waits for the children still
        // at work: pausing ends the turn, and that would cancel them.
        pauseAfterStep: () => turnPausesOnHeldCalls(agents, run),
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
        status: "cancelled",
        ...stopReason(),
        parts: interruptedParts,
      })
    }

    // A child waiting on its question pauses on it while the turn still runs: a waiting child
    // would hold the wait below forever, and the turn's end cancels the children still at work.
    const stopWaitingAt = runtime.deadline.getTime() - PAUSE_WAIT_MARGIN_MS
    await input.children?.defer(stopWaitingAt, abortSignal)

    // A call held after the last step that ran tools, by a command left running in the sandbox or
    // by a child, pauses the turn too. Its end cancels the children still at work, so it first
    // waits for them: one that holds a call pauses by itself instead of being stopped.
    if (result.status === "paused" || (await holdsApproval(agents, run))) {
      await input.children?.settle(stopWaitingAt, abortSignal)
    }
    const interruptedWhileWaiting = await finalizeIfInterrupted()
    if (interruptedWhileWaiting) return interruptedWhileWaiting

    const finishReason =
      result.status === "paused" || (await holdsApproval(agents, run))
        ? "awaiting_approval"
        : (coerceAgentRunFinishReason(result.finishReason) ?? "unknown")
    const assistant: AgentMessage = { role: "assistant", parts: interruptedParts }
    const diagnostics = [
      stepLimitDiagnostic(assistant, { finishReason, maxSteps }),
      outputLimitDiagnostic(finishReason),
    ].filter((diagnostic) => diagnostic !== undefined)
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

    await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
    await context.streamSink.publishRunFinished(finalizedRun)
    return finalizedRun
  } finally {
    if (ownsRuntime) runtime.dispose()
  }
}

/**
 * Whether the turn holds a call for its requester, as `runs.finish` checks before it pauses: one
 * waiting, or decided and not reported to the model yet, its children's included.
 */
function holdsApproval(agents: AgentStorage, run: ConversationAgentRunRecord): Promise<boolean> {
  return agents.approvals.holdsRun({ projectId: run.projectId, runId: run.id })
}

/**
 * How long before its deadline a pausing turn stops waiting for its children: enough to record its
 * pause, which then cancels those still at work.
 */
export const PAUSE_WAIT_MARGIN_MS = 10_000

/**
 * Whether the worker's stop, rather than the user's, ended the turn. Whichever fired first wins:
 * the combined turn signal carries the reason of the first source that aborted it.
 */
export function stoppedByWorker(turnSignal: AbortSignal, stopSignal?: AbortSignal): boolean {
  return stopSignal?.aborted === true && turnSignal.reason === stopSignal.reason
}

/**
 * A turn that ran out of steps before answering says so through a diagnostic, which chats render in
 * the reader's language, rather than through text written into the transcript.
 */
function stepLimitDiagnostic(
  message: AgentMessage,
  input: { readonly finishReason: string | undefined; readonly maxSteps: number }
): AgentRunDiagnostic | undefined {
  if (hasVisibleText(message.parts) || input.finishReason !== "tool-calls") return undefined
  return {
    code: "step_limit_reached",
    severity: "warning",
    scope: "run",
    message: `The Agent reached its ${input.maxSteps}-step limit before producing a final answer.`,
  }
}

/**
 * An answer the output limit cut short keeps what the model produced, reasoning included, and says
 * so the same way. Its unfinished tool calls were dropped unexecuted.
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

function hasVisibleText(parts: AgentMessage["parts"]): boolean {
  return parts.some((part) => part.type === "text" && part.text.trim().length > 0)
}

/** Persist an interrupted turn, retaining coherent partial content when any was produced. */
async function finalizeInterruptedTurn(input: {
  readonly session: AgentRunSession
  readonly context: AgentTurnContext
  readonly run: ConversationAgentRunRecord
  readonly modelId?: string
  readonly status: "failed" | "cancelled"
  readonly finishReason?: Exclude<AgentRunFinishReason, "awaiting_approval" | "awaiting_answer">
  readonly error?: AgentRunFailure
  readonly completedAt?: Date
  readonly parts?: readonly AgentMessagePart[]
}): Promise<AgentRunRecord> {
  const { session, context, run, modelId, status, finishReason, error, completedAt } = input
  const parts = input.parts?.some((part) => part.type !== "step-start") ? input.parts : undefined

  await context.beforeFinalize?.()

  const outcome = {
    status,
    ...(modelId === undefined ? {} : { modelId }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(error === undefined ? {} : { error }),
    ...(completedAt === undefined ? {} : { completedAt }),
  }
  if (!parts) {
    const finalizedRun = await session.finish(outcome)
    await context.streamSink.publishRunFinished(finalizedRun)
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
  await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
  await context.streamSink.publishRunFinished(finalizedRun)
  return finalizedRun
}
