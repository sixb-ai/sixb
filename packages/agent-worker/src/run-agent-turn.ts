import type { AgentDefinition, AgentMessage, AgentMessagePart, Storage } from "@sixb/core"
import { createAgentMessageId, runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { isAbortError, QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import {
  type AgentRunFinishReason,
  type AgentRunRecord,
  type AgentStorage,
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
import { type AgentRunFailure, toAgentExecutionFailure } from "./failure"
import { appendMessageAndFinishRunOrThrow, finishRunOrThrow } from "./finalize"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { AiModelCallRecorder } from "./model-call-recorder"
import { collectAgentOutputAttachments } from "./output-attachments"
import { loadAgentThreadModelContext } from "./thread-context"
import type { AgentTurnContext } from "./types"

export const DEFAULT_MAX_STEPS = 25

export interface RunAgentTurnInput {
  /** The worker's stable execution context (storage, tools, stream sink, and turn limits). */
  readonly context: AgentTurnContext
  readonly agent: AgentDefinition
  /** The run this delivery reserved or reclaimed with its execution token. */
  readonly run: AgentRunRecord
  /** The worker's shutdown signal. */
  readonly signal: AbortSignal
}

/** Drive one provider-neutral model/tool turn to completion and persist it. */
export async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentRunRecord> {
  const { context, agent, run, signal } = input
  const { id: projectId, storage, tools, defaultMaxSteps, turnTimeoutMs } = context
  const runId = run.id
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent run '${runId}' has no execution token.`,
      { details: { agentId: run.agentId, runId } }
    )
  }
  const agents = storage.agents

  const threadContext = await loadAgentThreadModelContext({
    storage: agents,
    projectId,
    threadId: run.threadId,
  })
  const attachmentContext =
    context.attachmentContext ??
    (context.apiBaseUrl
      ? await prepareAgentAttachments({
          projectId,
          threadId: run.threadId,
          messages: threadContext.retainedMessages,
          blobStorage: context.blobStorage,
          apiBaseUrl: context.apiBaseUrl,
          inlineImages: modelSupportsInlineImages(agent.model),
          signal,
        })
      : undefined)
  const modelMessages = toModelMessages(threadContext.modelMessages, {
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

  const maxSteps = agent.loop?.stopWhen?.maxSteps ?? defaultMaxSteps
  const usageRecorder = new AiModelCallRecorder({
    storage,
    projectId,
    executionId: run.executionId,
    attempt: run.attempt,
    requesterGroupIds: run.requesterGroupIds,
    recoverAiModelCall: context.recoverAiModelCall,
    errorRunId: runId,
  })

  const timeoutAbort = new AbortController()
  let timedOut = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    timeoutAbort.abort()
  }, turnTimeoutMs)

  // Sandbox provisioning runs beside the first model call. A failure aborts the turn promptly and
  // takes precedence over the synthetic abort it causes.
  const provisionAbort = new AbortController()
  let provisionError: unknown
  context.sandboxReady?.catch((error) => {
    provisionError = error
    provisionAbort.abort()
  })

  const abortSignal = AbortSignal.any([signal, timeoutAbort.signal, provisionAbort.signal])
  let interruptedParts: readonly AgentMessagePart[] | undefined

  const finalizeIfInterrupted = async (error?: unknown): Promise<AgentRunRecord | null> => {
    if (signal.reason instanceof QueueDeliveryLeaseLostError) throw signal.reason
    usageRecorder.assertHealthy()
    if (provisionError !== undefined) throw provisionError
    if (timedOut) {
      const completedAt = new Date()
      return finalizeInterruptedTurn({
        storage,
        agents,
        context,
        run,
        executionToken,
        projectId,
        modelId: agent.model.modelId,
        status: "failed",
        finishReason: "timeout",
        error: toAgentExecutionFailure(new AgentTurnTimeoutError(runId, turnTimeoutMs), {
          status: "failed",
          at: completedAt,
          details: {
            agentId: run.agentId,
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
      modelId: agent.model.modelId,
      status: "cancelled",
      parts: interruptedParts,
    })
  }

  try {
    let chunkIndex = 0
    let result: Awaited<ReturnType<typeof runModelLoop>>
    try {
      result = await runModelLoop({
        model: agent.model,
        messages: [
          {
            role: "system",
            content: context.systemPrompt,
          },
          ...modelMessages,
        ],
        tools,
        ...(agent.reasoning === undefined ? {} : { reasoning: agent.reasoning }),
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
            agentId: agent.id,
            runId,
          })
        : agentTraceFromModelSteps(result.steps, { agentId: agent.id, runId })

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
        modelId: agent.model.modelId,
        status: "cancelled",
        parts: interruptedParts,
      })
    }

    const finishReason = coerceAgentRunFinishReason(result.finishReason) ?? "unknown"
    const assistant = ensureVisibleAssistantMessage(
      { role: "assistant", parts: interruptedParts },
      { finishReason, maxSteps }
    )
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

    const finalizedRun = await appendMessageAndFinishRunOrThrow(storage, {
      message: {
        id: assistantMessageId,
        projectId,
        threadId: run.threadId,
        runId,
        role: assistant.role,
        parts: assistantParts,
        authorPrincipal: context.agentPrincipal,
      },
      finish: {
        projectId,
        id: runId,
        executionToken,
        status: "succeeded",
        modelId: agent.model.modelId,
        finishReason,
        ...(outputAttachments.diagnostics.length === 0
          ? {}
          : { diagnostics: outputAttachments.diagnostics }),
      },
    })

    await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
    await context.streamSink.publishRunFinished(finalizedRun)
    return finalizedRun
  } finally {
    clearTimeout(timeoutTimer)
  }
}

function ensureVisibleAssistantMessage(
  message: AgentMessage,
  input: { readonly finishReason: string | undefined; readonly maxSteps: number }
): AgentMessage {
  if (hasVisibleText(message.parts) || input.finishReason !== "tool-calls") return message
  return {
    ...message,
    parts: [
      ...message.parts,
      {
        type: "text",
        text: `I reached the configured ${input.maxSteps}-step limit before producing a final answer. Ask me to continue and I can use the work above as context.`,
      },
    ],
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
  readonly run: AgentRunRecord
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
      authorPrincipal: context.agentPrincipal,
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
