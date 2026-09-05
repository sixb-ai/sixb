import type { AgentMessage } from "@sixb/core"
import { runModelLoop } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import { coerceAgentRunFinishReason, type SubagentRunRecord } from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION } from "./agent-prompt"
import { assistantPartsWithAttachments } from "./assistant-attachments"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { finishRunOrThrow } from "./finalize"
import { agentTraceFromModelSteps } from "./model-adapters"
import { collectAgentOutputAttachments } from "./output-attachments"
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
  let runtime = input.runtime
  if (!runtime) {
    const execution = await context.storage.executions.getById({
      projectId: context.id,
      id: run.executionId,
    })
    if (!execution) {
      throw createSixbError("internal.unexpected", "Subagent execution is not available.", {
        details: { runId: run.id, executionId: run.executionId },
      })
    }
    runtime = createAgentTurnRuntime({
      context,
      run,
      signal,
      requestedBy: execution.requestedBy,
    })
  }
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  try {
    let chunkIndex = 0
    const generation = await runModelLoop({
      model: runtime.usageRecorder.wrapModel(plan.model),
      messages: [
        { role: "system", content: context.systemPrompt },
        { role: "user", content: [{ type: "text", text: run.spec.task }] },
      ],
      tools: context.tools,
      ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
      maxSteps: plan.maxSteps,
      finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
      ...(context.prepareStep === undefined ? {} : { prepareStep: context.prepareStep }),
      signal: abortSignal,
      onModelCallEnd: runtime.usageRecorder.onModelCallEnd,
      onEvent: (chunk) =>
        context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk }),
    })
    assertSubagentCanFinalize({ runtime, sandboxReadiness })
    if (generation.status === "aborted")
      throw new DOMException("Subagent stream was aborted.", "AbortError")
    const parts = agentTraceFromModelSteps(generation.steps, {
      parentRunId: run.parentRunId,
      runId: run.id,
    })
    const outputAttachments = await collectAgentOutputAttachments({
      sandboxReady: context.sandboxReady,
      sandboxWasUsed: context.sandboxWasUsed,
      blobStorage: context.blobStorage,
      signal: abortSignal,
    })
    assertSubagentCanFinalize({ runtime, sandboxReadiness })
    const childResult = subagentResult(
      assistantPartsWithAttachments(parts, outputAttachments.attachments),
      run
    )

    const finalized = await finishRunOrThrow(context.storage.agents, {
      projectId: context.id,
      id: run.id,
      executionToken,
      status: "succeeded",
      modelId: plan.model.modelId,
      finishReason: coerceAgentRunFinishReason(generation.finishReason) ?? "unknown",
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
}): void {
  if (input.runtime.sourceSignal.reason instanceof QueueDeliveryLeaseLostError) {
    throw input.runtime.sourceSignal.reason
  }
  input.runtime.usageRecorder.assertHealthy()
  input.sandboxReadiness.throwIfFailed()
  input.runtime.assertCanContinue()
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
