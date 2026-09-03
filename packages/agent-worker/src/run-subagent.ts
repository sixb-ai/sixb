import type { AgentInboundUiMessage, AgentMessage } from "@sixb/core"
import { fromAiSdk } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { SubagentRunRecord } from "@sixb/core/storage"
import { toUIMessageStream } from "ai"
import { agentToolErrorText } from "./ai-sdk-adapters"
import { assistantPartsWithAttachments } from "./assistant-attachments"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { finishRunOrThrow } from "./finalize"
import { collectAgentOutputAttachments } from "./output-attachments"
import { runAgentLoop } from "./run-agent-loop"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import { type AgentTurnRuntime, createAgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

export async function runSubagent(input: {
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly run: SubagentRunRecord
  readonly signal: AbortSignal
  readonly runtime?: AgentTurnRuntime
}): Promise<SubagentRunRecord> {
  const { context, plan, run, signal } = input
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Subagent run '${run.id}' has no execution token.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }

  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  const ownsRuntime = input.runtime === undefined
  const runtime =
    input.runtime ??
    createAgentTurnRuntime({
      context,
      run,
      signal,
      providerOptions: plan.providerOptions,
    })
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  let responseMessage: AgentInboundUiMessage | undefined
  let streamAborted = false
  let modelError: unknown

  try {
    const generation = runAgentLoop({
      plan,
      system: context.systemPrompt,
      messages: [{ role: "user", content: run.spec.task }],
      tools: context.tools,
      usageRecorder: runtime.usageRecorder,
      prepareStep: context.prepareStep,
      abortSignal,
      onError: ({ error }) => {
        modelError ??= error
      },
    })
    const uiStream = toUIMessageStream({
      stream: generation.stream,
      tools: context.tools,
      onError: agentToolErrorText,
      onEnd: (event) => {
        responseMessage = event.responseMessage
        streamAborted = streamAborted || event.isAborted
      },
    })

    let chunkIndex = 0
    const reader = uiStream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk: value })
    }

    assertSubagentCanFinalize({ runtime, sandboxReadiness, streamAborted, modelError })
    if (!responseMessage) {
      throw createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Subagent run '${run.id}' produced no response.`,
        { details: { parentRunId: run.parentRunId, runId: run.id } }
      )
    }

    const assistant = fromAiSdk(responseMessage)
    const outputAttachments = await collectAgentOutputAttachments({
      sandboxReady: context.sandboxReady,
      sandboxWasUsed: context.sandboxWasUsed,
      blobStorage: context.blobStorage,
      signal: abortSignal,
    })
    assertSubagentCanFinalize({ runtime, sandboxReadiness, streamAborted, modelError })
    const childResult = subagentResult(
      assistantPartsWithAttachments(assistant.parts, outputAttachments.attachments),
      run
    )

    const finalized = await finishRunOrThrow(context.storage.agents, {
      projectId: context.id,
      id: run.id,
      executionToken,
      status: "succeeded",
      modelId: plan.model.modelId,
      finishReason: await generation.finishReason,
      ...(outputAttachments.diagnostics.length === 0
        ? {}
        : { diagnostics: outputAttachments.diagnostics }),
      result: childResult,
    })
    if (finalized.kind !== "subagent") {
      throw new Error(
        `[SixbAgentWorker] Subagent run '${run.id}' changed kind during finalization.`
      )
    }
    await context.streamSink.publishRunFinished(finalized)
    return finalized
  } finally {
    if (ownsRuntime) runtime.dispose()
  }
}

function assertSubagentCanFinalize(input: {
  readonly runtime: AgentTurnRuntime
  readonly sandboxReadiness: ReturnType<typeof monitorSandboxReadiness>
  readonly streamAborted: boolean
  readonly modelError: unknown
}): void {
  if (input.runtime.sourceSignal.reason instanceof QueueDeliveryLeaseLostError) {
    throw input.runtime.sourceSignal.reason
  }
  input.runtime.usageRecorder.assertHealthy()
  input.sandboxReadiness.throwIfFailed()
  input.runtime.assertCanContinue()
  if (input.modelError !== undefined) throw input.modelError
  if (input.streamAborted) {
    throw new DOMException("Subagent stream was aborted.", "AbortError")
  }
}

function subagentResult(
  parts: AgentMessage["parts"],
  run: SubagentRunRecord
): NonNullable<SubagentRunRecord["result"]> {
  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
  const files = parts.flatMap((part) => (part.type === "file" ? [part.fileRef] : []))
  if (!text && files.length === 0) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Subagent run '${run.id}' produced no final text or file result.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }
  return {
    ...(text ? { text } : {}),
    ...(files.length === 0 ? {} : { files }),
  }
}
