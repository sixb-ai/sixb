import type { AgentInboundUiMessagePart, AgentMessage, Storage } from "@sixb/core"
import { createAgentMessageId, fromAiSdk, toModelMessages } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { isAbortError, QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type {
  AgentRunFinishReason,
  AgentRunRecord,
  AgentStorage,
  ConversationAgentRunRecord,
} from "@sixb/core/storage"
import { type ModelMessage, toUIMessageStream } from "ai"
import { agentToolErrorText } from "./ai-sdk-adapters"
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
import { collectAgentOutputAttachments } from "./output-attachments"
import { runAgentLoop } from "./run-agent-loop"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { LoadedAgentThreadModelContext } from "./thread-context"
import { loadAgentThreadModelContext } from "./thread-context"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

export const DEFAULT_MAX_STEPS = 25

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

/**
 * Drive one agent turn to completion and persist it.
 *
 * Loads thread history, streams the model with the configured stop condition, then persists the
 * assistant message and finalizes the run with usage and finish reason. Message and run writes are
 * fenced by the delivery's execution token; completed provider-call usage remains billable and is
 * recorded even when queue ownership is later lost.
 *
 * It returns the finalized run for success, cancellation, and a wall-clock timeout (including any
 * coherent partial response). Model/tool failures and exceptional shutdown paths propagate to the
 * caller, which records the run's terminal fate.
 */
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
          inlineImages: await modelSupportsInlineImages(plan.model, signal),
          signal,
        })
      : undefined)
  // `toModelMessages` is core's `ai`-free mirror of `convertToModelMessages`. The only type gap is
  // `providerOptions`, which core types as the wider `JsonValue` (it cannot depend on `ai`); the
  // values originate from the SDK, so the runtime shape is compatible. The worker is where `ai`
  // lives, so this single boundary cast belongs here. Locked by `tests/ai-sdk-compat.types.ts`.
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
  }) as ModelMessage[]

  // The sandbox provisions concurrently with this turn (see `createConversationAgentEnvironment`). If it
  // fails, the run must be recorded `failed` rather than finalizing as a success with a dead
  // sandbox — even when the model never invokes bash. Capture the cause and abort the stream so the
  // turn ends now. We do NOT await provisioning before finalizing: a turn that out-runs a slow boot
  // keeps the latency win, so a boot that fails only after the turn has drained still finalizes
  // (best-effort strict).
  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)

  // Production passes the run-owned runtime created before preflight. Direct callers that skip
  // preflight start it here, after fallible history and attachment preparation, so setup failures
  // do not leave a detached deadline timer behind.
  const ownsRuntime = input.runtime === undefined
  const runtime =
    input.runtime ??
    createAgentTurnRuntime({
      context,
      run,
      signal,
      providerOptions: plan.providerOptions,
    })
  const usageRecorder = runtime.usageRecorder
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])

  // `onFinish` fires even when the stream is aborted — the SDK ends the UI stream gracefully with an
  // `abort` chunk rather than erroring it. `isAborted` distinguishes a stop from a clean finish, and
  // `responseMessage` holds whatever streamed so far, so a cancelled turn can still be persisted.
  let responseMessage: AgentInboundLike | undefined
  let streamAborted = false
  let result: ReturnType<typeof runAgentLoop>
  let uiStream: ReturnType<typeof toUIMessageStream>
  try {
    result = runAgentLoop({
      plan,
      system: context.systemPrompt,
      messages: modelMessages,
      tools,
      usageRecorder,
      prepareStep: context.prepareStep,
      abortSignal,
    })
    uiStream = toUIMessageStream({
      stream: result.stream,
      tools,
      onError: agentToolErrorText,
      onEnd: (event) => {
        responseMessage = event.responseMessage
        streamAborted = streamAborted || event.isAborted
      },
    })
  } catch (error) {
    if (ownsRuntime) runtime.dispose()
    throw error
  }

  let drainError: unknown
  let chunkIndex = 0
  try {
    // Draining the UI stream drives the model loop and fires `onEnd`. Chunks are live UI state:
    // publish them to the broker stream, but keep durable messages final-only. The standalone
    // `toUIMessageStream` returns a plain `ReadableStream`, so read it with a reader rather than
    // `for await` (which needs `Symbol.asyncIterator`, absent under the CI lib config).
    const reader = uiStream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      await context.streamSink.publishUiChunk({
        run,
        chunkIndex: chunkIndex++,
        chunk: value,
      })
    }
  } catch (error) {
    drainError = error
  }

  const finalizeIfInterrupted = async (error?: unknown): Promise<AgentRunRecord | null> => {
    if (runtime.sourceSignal.reason instanceof QueueDeliveryLeaseLostError) {
      throw runtime.sourceSignal.reason
    }
    // AI SDK swallows lifecycle callback errors, so surface a retained ledger append failure before
    // interpreting the stream as a success or cancellation.
    usageRecorder.assertHealthy()
    // A sandbox failure and a timeout take precedence over the abort-shaped error they cause.
    sandboxReadiness.throwIfFailed()
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
        partial: responseMessage,
      })
    }
    if (!streamAborted && !abortSignal.aborted && (error === undefined || !isAbortError(error))) {
      return null
    }
    return finalizeInterruptedTurn({
      storage,
      agents,
      context,
      run,
      executionToken,
      projectId,
      modelId: plan.model.modelId,
      status: "cancelled",
      partial: responseMessage,
    })
  }

  try {
    // A user cancel (or worker shutdown) aborts the stream, which the SDK ends gracefully — so we reach
    // here with no drain error, only the `isAborted`/signal flags. Persist whatever streamed so far as a
    // `cancelled` turn — the agent's tool calls and partial text — so the next (steering) turn keeps the
    // context of what it was doing, instead of throwing the whole response away.
    const interruptedAfterStream = await finalizeIfInterrupted(drainError)
    if (interruptedAfterStream) {
      return interruptedAfterStream
    }
    if (drainError !== undefined) {
      throw drainError
    }
    if (!responseMessage) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] Agent run '${runId}' produced no response message.`,
        { details: { runId, threadId: run.threadId } }
      )
    }

    const finishReason = await result.finishReason
    const assistant = ensureVisibleAssistantMessage(fromAiSdk(responseMessage), {
      finishReason,
      maxSteps: plan.maxSteps,
    })
    let outputAttachments: Awaited<ReturnType<typeof collectAgentOutputAttachments>>
    try {
      outputAttachments = await collectAgentOutputAttachments({
        sandboxReady: context.sandboxReady,
        sandboxWasUsed: context.sandboxWasUsed,
        blobStorage: context.blobStorage,
        signal: abortSignal,
      })
    } catch (error) {
      const interruptedDuringCollection = await finalizeIfInterrupted(error)
      if (interruptedDuringCollection) {
        return interruptedDuringCollection
      }
      throw error
    }

    // Cancellation, timeout, or queue ownership loss may happen after the model stream drained while output
    // files are being collected. Re-check all terminal signals before the fenced write so an abort
    // can never be finalized as success.
    const interruptedAfterCollection = await finalizeIfInterrupted()
    if (interruptedAfterCollection) {
      return interruptedAfterCollection
    }
    const assistantParts = assistantPartsWithAttachments(
      assistant.parts,
      outputAttachments.attachments
    )
    const assistantMessageId = createAgentMessageId()

    // Keep the final signal check adjacent to the transaction. Collection or queue renewal can yield
    // long enough for a cancellation to arrive.
    const interruptedBeforeCommit = await finalizeIfInterrupted()
    if (interruptedBeforeCommit) {
      return interruptedBeforeCommit
    }

    // The assistant append and run finish share one transaction, so redelivery cannot observe a
    // finalized message without the terminal run state that releases the thread. Transient blips are
    // retried in place.
    const finalizedRun = await appendMessageAndFinishRunOrThrow(storage, {
      message: {
        id: assistantMessageId,
        projectId,
        threadId: run.threadId,
        runId,
        role: assistant.role,
        parts: assistantParts,
        ...(assistant.metadata === undefined ? {} : { metadata: assistant.metadata }),
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
        ...(outputAttachments.diagnostics.length === 0
          ? {}
          : { diagnostics: outputAttachments.diagnostics }),
      },
    })

    await context.streamSink.publishMessageFinalized({
      run,
      messageId: assistantMessageId,
    })
    await context.streamSink.publishRunFinished(finalizedRun)

    return finalizedRun
  } finally {
    if (ownsRuntime) runtime.dispose()
  }
}

function ensureVisibleAssistantMessage(
  message: AgentMessage,
  input: { readonly finishReason: string | undefined; readonly maxSteps: number }
): AgentMessage {
  if (hasVisibleText(message.parts) || input.finishReason !== "tool-calls") {
    return message
  }
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

/**
 * Persist an interrupted turn, keeping whatever coherently streamed. When the partial has usable
 * content it is written as the assistant message in the same transaction as the run finish
 * (mirroring the success path); otherwise the run is just finalized with no message. User stops are
 * `cancelled`; a wall-clock timeout is `failed` with a stable `timeout` finish reason.
 */
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
  readonly partial: AgentInboundLike | undefined
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
    partial,
  } = input

  // A malformed partial must not turn a cancel into a failure: fall back to a message-less cancel.
  let assistant: AgentMessage | null = null
  try {
    assistant = partial ? coercePartialAssistantMessage(partial) : null
  } catch {
    assistant = null
  }

  if (!assistant) {
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
      role: assistant.role,
      parts: assistantPartsWithAttachments(assistant.parts),
      ...(assistant.metadata === undefined ? {} : { metadata: assistant.metadata }),
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

function isToolUiPart(type: string): boolean {
  return type === "dynamic-tool" || type.startsWith("tool-")
}

/**
 * Coerce a partially-streamed assistant message into a coherent, persistable one: finalize the
 * trailing (still-streaming) text so the partial answer is kept, keep completed tool calls, mark a
 * tool call that had its full input but never resolved as a cancelled error (so replay stays paired),
 * and drop still-streaming reasoning or tool input that never finished. Returns null when nothing
 * coherent streamed, so the caller finalizes the run without a message.
 */
function coercePartialAssistantMessage(message: AgentInboundLike): AgentMessage | null {
  const parts: AgentInboundUiMessagePart[] = []
  for (const part of message.parts) {
    if (part.type === "text") {
      if (typeof part.text === "string" && part.text.trim().length > 0) {
        parts.push({
          type: "text",
          text: part.text,
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
        })
      }
    } else if (part.type === "reasoning") {
      // Only keep reasoning that finished streaming — it carries the provider signature needed on the
      // next turn; a half-streamed thinking block is dropped rather than replayed.
      if (
        part.state !== "streaming" &&
        typeof part.text === "string" &&
        part.text.trim().length > 0
      ) {
        parts.push({
          type: "reasoning",
          text: part.text,
          ...(part.providerMetadata === undefined
            ? {}
            : { providerMetadata: part.providerMetadata }),
        })
      }
    } else if (part.type === "step-start") {
      parts.push({ type: "step-start" })
    } else if (isToolUiPart(part.type)) {
      if (part.state === "output-available" || part.state === "output-error") {
        parts.push(part)
      } else if (part.state === "input-available") {
        parts.push({ ...part, state: "output-error", errorText: "Tool execution was cancelled." })
      }
      // `input-streaming` (input never finished) is dropped: its input is not valid JSON yet.
    }
  }
  // A bare step boundary is structural, not usable progress. Do not create an assistant message
  // that renders empty and would make clients offer Continue after a pre-content timeout.
  if (parts.every((part) => part.type === "step-start")) {
    return null
  }
  return fromAiSdk({
    role: message.role,
    parts,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
  })
}

// `toUIMessageStream`'s `onFinish` hands back the SDK `UIMessage`; `fromAiSdk` accepts the wider
// inbound shape. We keep the parameter loose here and let `fromAiSdk` narrow/validate at runtime.
type AgentInboundLike = Parameters<typeof fromAiSdk>[0]
