import type { AgentDefinition, AgentMessage, AgentMessagePart, Storage } from "@sixb/core"
import {
  buildAgentSystemPrompt,
  createAgentMessageId,
  toModelMessages,
} from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { isAbortError, QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { AgentRunRecord, AgentStorage } from "@sixb/core/storage"
import { runModelLoop } from "@sixb/llm"
import { attachmentKey, modelSupportsInlineImages, prepareAgentAttachments } from "./attachments"
import { AgentTurnTimeoutError } from "./errors"
import { appendMessageAndFinishRunOrThrow, finishRunOrThrow } from "./finalize"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { AiModelCallRecorder } from "./model-call-recorder"
import {
  type AgentOutputAttachmentResult,
  collectAgentOutputAttachments,
} from "./output-attachments"
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

  const history = await agents.messages.list({ projectId, threadId: run.threadId, order: "asc" })
  const attachmentContext =
    context.attachmentContext ??
    (context.apiBaseUrl
      ? await prepareAgentAttachments({
          projectId,
          threadId: run.threadId,
          messages: history.messages,
          blobStorage: context.blobStorage,
          apiBaseUrl: context.apiBaseUrl,
          inlineImages: await modelSupportsInlineImages(agent.model),
        })
      : undefined)
  const modelMessages = toModelMessages(history.messages, {
    fileText: ({ message, partIndex }) =>
      attachmentContext?.promptTextByPartKey.get(attachmentKey(message.id, partIndex)),
    fileData: ({ message, partIndex }) =>
      attachmentContext?.modelFileDataByPartKey.get(attachmentKey(message.id, partIndex)),
  })

  const maxSteps = agent.loop?.stopWhen?.maxSteps ?? defaultMaxSteps
  const usageRecorder = new AiModelCallRecorder({
    storage: storage.aiUsage,
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

  // Sandbox provisioning runs alongside the first model call. If it fails before the turn drains,
  // abort promptly and prefer the provisioning failure over its synthetic abort.
  const provisionAbort = new AbortController()
  let provisionError: unknown
  context.sandboxReady?.catch((error) => {
    provisionError = error
    provisionAbort.abort()
  })

  const abortSignal = AbortSignal.any([signal, timeoutAbort.signal, provisionAbort.signal])
  let cancelledParts: readonly AgentMessagePart[] | undefined

  const finalizeIfInterrupted = async (error?: unknown): Promise<AgentRunRecord | null> => {
    if (signal.reason instanceof QueueDeliveryLeaseLostError) throw signal.reason
    usageRecorder.assertHealthy()
    if (provisionError !== undefined) throw provisionError
    if (timedOut) throw new AgentTurnTimeoutError(runId, turnTimeoutMs)
    if (!abortSignal.aborted && (error === undefined || !isAbortError(error))) return null
    return finalizeCancelledTurn({
      storage,
      agents,
      context,
      run,
      executionToken,
      projectId,
      modelId: agent.model.modelId,
      parts: cancelledParts,
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
            content: buildAgentSystemPrompt({
              instructions: agent.instructions,
              addendum: context.systemAddendum,
            }),
          },
          ...modelMessages,
        ],
        tools,
        ...(agent.reasoning === undefined ? {} : { reasoning: agent.reasoning }),
        maxSteps,
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

    cancelledParts =
      result.status === "aborted"
        ? agentTraceFromPartialModelLoop(result.steps, result.partialContent, {
            agentId: agent.id,
            runId,
          })
        : agentTraceFromModelSteps(result.steps, { agentId: agent.id, runId })

    const interruptedAfterModel = await finalizeIfInterrupted()
    if (interruptedAfterModel) return interruptedAfterModel
    if (result.status === "aborted") {
      // A provider may stop without propagating a signal reason; preserve its coherent partial and
      // still finalize as cancelled rather than treating it as a successful empty response.
      return finalizeCancelledTurn({
        storage,
        agents,
        context,
        run,
        executionToken,
        projectId,
        modelId: agent.model.modelId,
        parts: cancelledParts,
      })
    }

    const finishReason = result.finishReason
    const assistant = ensureVisibleAssistantMessage(
      { role: "assistant", parts: cancelledParts },
      { finishReason, maxSteps }
    )
    let outputAttachments: AgentOutputAttachmentResult
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
    const assistantParts = assistantPartsWithOutputAttachments(assistant.parts, outputAttachments)
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

function assistantPartsWithOutputAttachments(
  parts: readonly AgentMessagePart[],
  output: AgentOutputAttachmentResult
): AgentMessagePart[] {
  return [
    ...parts,
    ...output.attachments.map((attachment) => ({
      type: "file" as const,
      fileRef: attachment.fileRef,
    })),
  ]
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

/** Persist a cancelled turn, retaining coherent partial content when any was produced. */
async function finalizeCancelledTurn(input: {
  readonly storage: Storage
  readonly agents: AgentStorage
  readonly context: AgentTurnContext
  readonly run: AgentRunRecord
  readonly executionToken: string
  readonly projectId: string
  readonly modelId?: string
  readonly parts?: readonly AgentMessagePart[]
}): Promise<AgentRunRecord> {
  const { storage, agents, context, run, executionToken, projectId, modelId } = input
  const parts = input.parts?.some((part) => part.type !== "step-start") ? input.parts : undefined

  if (!parts) {
    const finalizedRun = await finishRunOrThrow(agents, {
      projectId,
      id: run.id,
      executionToken,
      status: "cancelled",
      ...(modelId === undefined ? {} : { modelId }),
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
      status: "cancelled",
      ...(modelId === undefined ? {} : { modelId }),
    },
  })
  await context.streamSink.publishMessageFinalized({ run, messageId: assistantMessageId })
  await context.streamSink.publishRunFinished(finalizedRun)
  return finalizedRun
}
