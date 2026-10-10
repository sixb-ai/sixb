import type { AgentMessage, AgentMessagePart, Storage } from "@sixb/core"
import { createAgentMessageId, runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
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
import { assistantPartsWithAttachments } from "./assistant-attachments"
import {
  attachmentKey,
  modelSupportsInlineImages,
  prepareAgentAttachments,
  toolResultAttachmentKey,
} from "./attachments"
import { AgentTurnTimeoutError } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { type AgentRunFailure, toAgentExecutionFailure } from "./failure"
import { appendMessageAndFinishRunOrThrow, finishRunOrThrow } from "./finalize"
import { loadUserMessageTimes } from "./message-times"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { collectAgentOutputAttachments } from "./output-attachments"
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
  /** The worker's shutdown signal. */
  readonly signal: AbortSignal
  /** Shared with preflight when this turn performed compaction. */
  readonly runtime?: AgentTurnRuntime
  /** Preflight's retained projection, avoiding a second storage read in the worker path. */
  readonly threadContext?: LoadedAgentThreadModelContext
}

/** Drive one provider-neutral model/tool turn to completion and persist it. */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentRunRecord> {
  const { context, plan, run, signal } = input
  const { id: projectId, storage, tools, turnTimeoutMs } = context
  const runId = run.id
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent run '${runId}' has no execution token.`,
      { details: { runId, threadId: run.threadId } }
    )
  }
  const agents = storage.agents

  const threadContext =
    input.threadContext ??
    (await loadAgentThreadModelContext({
      storage: agents,
      projectId,
      threadId: run.threadId,
    }))
  const attachmentContext =
    context.attachmentContext ??
    (context.apiBaseUrl
      ? await prepareAgentAttachments({
          projectId,
          threadId: run.threadId,
          messages: threadContext.retainedMessages,
          blobStorage: context.blobStorage,
          apiBaseUrl: context.apiBaseUrl,
          inlineImages: modelSupportsInlineImages(plan.model),
          signal,
        })
      : undefined)
  const sentTimes = await loadUserMessageTimes({
    storage: agents,
    projectId,
    threadId: run.threadId,
    messages: threadContext.retainedMessages,
    projectTimeZone: context.projectTimeZone,
  })
  const modelMessages = toModelMessages(threadContext.modelMessages, {
    userMessageSuffix: (message) => (message.id ? sentTimes.get(message.id) : undefined),
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
    const durableExecution = await storage.executions.getById({
      projectId,
      id: run.executionId,
    })
    if (!durableExecution) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${runId}' references missing execution '${run.executionId}'.`,
        { details: { runId, executionId: run.executionId } }
      )
    }
    runtime = createAgentTurnRuntime({
      context,
      run,
      signal,
      execution: durableExecution,
    })
  }
  const usageRecorder = runtime.usageRecorder
  const abortSignal = AbortSignal.any([
    runtime.signal,
    sandboxReadiness.signal,
    ...(context.environmentFailureSignal ? [context.environmentFailureSignal] : []),
  ])
  let interruptedParts: readonly AgentMessagePart[] | undefined

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
        storage,
        agents,
        context,
        run,
        executionToken,
        projectId,
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
      storage,
      agents,
      context,
      run,
      executionToken,
      projectId,
      modelId: plan.model.modelId,
      status: "cancelled",
      parts: interruptedParts,
    })
  }

  try {
    let chunkIndex = 0
    let result: Awaited<ReturnType<typeof runModelLoop>>
    try {
      result = await runModelLoop({
        model: usageRecorder.wrapModel(plan.model),
        messages: [
          {
            role: "system",
            content: context.systemPrompt,
          },
          ...modelMessages,
        ],
        tools,
        ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
        maxSteps,
        finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
        ...(context.prepareStep === undefined ? {} : { prepareStep: context.prepareStep }),
        signal: abortSignal,
        onModelCallEnd: usageRecorder.onModelCallEnd,
        onEvent: async (chunk) => {
          await context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk })
        },
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
        storage,
        agents,
        context,
        run,
        executionToken,
        projectId,
        modelId: plan.model.modelId,
        status: "cancelled",
        parts: interruptedParts,
      })
    }

    const finishReason = coerceAgentRunFinishReason(result.finishReason) ?? "unknown"
    const assistant: AgentMessage = { role: "assistant", parts: interruptedParts }
    const stepLimit = stepLimitDiagnostic(assistant, { finishReason, maxSteps })
    let outputAttachments: Awaited<ReturnType<typeof collectAgentOutputAttachments>>
    try {
      outputAttachments = await collectAgentOutputAttachments({
        sandboxReady: context.sandboxReady,
        sandboxWasUsed: context.sandboxWasUsed,
        blobStorage: context.blobStorage,
        signal: abortSignal,
      })
    } catch (error) {
      const interrupted = await finalizeIfInterrupted(error)
      if (interrupted) return interrupted
      throw error
    }

    const interruptedAfterCollection = await finalizeIfInterrupted()
    if (interruptedAfterCollection) return interruptedAfterCollection
    const assistantParts = assistantPartsWithAttachments(
      assistant.parts,
      outputAttachments.attachments
    )
    const assistantMessageId = createAgentMessageId()

    const interruptedBeforeCommit = await finalizeIfInterrupted()
    if (interruptedBeforeCommit) return interruptedBeforeCommit

    await context.beforeFinalize?.()
    const finalizedRun = await appendMessageAndFinishRunOrThrow(storage, {
      message: {
        id: assistantMessageId,
        projectId,
        threadId: run.threadId,
        runId,
        role: assistant.role,
        parts: assistantParts,
        ...(context.authorPrincipal === undefined
          ? {}
          : { authorPrincipal: context.authorPrincipal }),
      },
      finish: {
        projectId,
        id: runId,
        executionToken,
        status: "succeeded",
        modelId: plan.model.modelId,
        finishReason,
        ...(outputAttachments.diagnostics.length === 0 && !stepLimit
          ? {}
          : {
              diagnostics: [...(stepLimit ? [stepLimit] : []), ...outputAttachments.diagnostics],
            }),
      },
    })

    await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
    await context.streamSink.publishRunFinished(finalizedRun)
    return finalizedRun
  } finally {
    if (ownsRuntime) runtime.dispose()
  }
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

function hasVisibleText(parts: AgentMessage["parts"]): boolean {
  return parts.some((part) => part.type === "text" && part.text.trim().length > 0)
}

/** Persist an interrupted turn, retaining coherent partial content when any was produced. */
async function finalizeInterruptedTurn(input: {
  readonly storage: Storage
  readonly agents: AgentStorage
  readonly context: AgentTurnContext
  readonly run: ConversationAgentRunRecord
  readonly executionToken: string
  readonly projectId: string
  readonly modelId?: string
  readonly status: "failed" | "cancelled"
  readonly finishReason?: AgentRunFinishReason
  readonly error?: AgentRunFailure
  readonly completedAt?: Date
  readonly parts?: readonly AgentMessagePart[]
}): Promise<AgentRunRecord> {
  const {
    storage,
    agents,
    context,
    run,
    executionToken,
    projectId,
    modelId,
    status,
    finishReason,
    error,
    completedAt,
  } = input
  const parts = input.parts?.some((part) => part.type !== "step-start")
    ? assistantPartsWithAttachments(input.parts)
    : undefined

  await context.beforeFinalize?.()

  if (!parts) {
    const finalizedRun = await finishRunOrThrow(agents, {
      projectId,
      id: run.id,
      executionToken,
      status,
      ...(modelId === undefined ? {} : { modelId }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(error === undefined ? {} : { error }),
      ...(completedAt === undefined ? {} : { completedAt }),
    })
    await context.streamSink.publishRunFinished(finalizedRun)
    return finalizedRun
  }

  const assistantMessageId = createAgentMessageId()
  const finalizedRun = await appendMessageAndFinishRunOrThrow(storage, {
    message: {
      id: assistantMessageId,
      projectId,
      threadId: run.threadId,
      runId: run.id,
      role: "assistant",
      parts,
      ...(context.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: context.authorPrincipal }),
    },
    finish: {
      projectId,
      id: run.id,
      executionToken,
      status,
      ...(modelId === undefined ? {} : { modelId }),
      ...(finishReason === undefined ? {} : { finishReason }),
      ...(error === undefined ? {} : { error }),
      ...(completedAt === undefined ? {} : { completedAt }),
    },
  })
  await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
  await context.streamSink.publishRunFinished(finalizedRun)
  return finalizedRun
}
