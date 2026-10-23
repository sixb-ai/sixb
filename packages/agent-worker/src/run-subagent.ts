import type { AgentMessage } from "@sixb/core"
import { runModelLoop } from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import { coerceAgentRunFinishReason, type SubagentRunRecord } from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION, withCurrentTime } from "./agent-prompt"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { finishRunOrThrow } from "./finalize"
import { agentTraceFromModelSteps } from "./model-adapters"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

export async function runSubagent(input: {
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly run: SubagentRunRecord
  /** Created by the worker before the run's tools, which share its signal and accounting. */
  readonly runtime: AgentTurnRuntime
}): Promise<SubagentRunRecord> {
  const { context, plan, run, runtime } = input
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Subagent run '${run.id}' has no execution token.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }

  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  let chunkIndex = 0
  const generation = await runModelLoop({
    model: runtime.usageRecorder.wrapModel(plan.model),
    messages: [
      { role: "system", content: context.systemPrompt },
      withCurrentTime(
        { role: "user", content: [{ type: "text", text: run.spec.task }] },
        run.createdAt,
        context.projectTimeZone
      ),
    ],
    tools: context.tools,
    ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
    maxSteps: plan.maxSteps,
    finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
    ...(context.prepareStep === undefined ? {} : { prepareStep: context.prepareStep }),
    signal: abortSignal,
    onModelCallEnd: runtime.usageRecorder.onModelCallEnd,
    onEvent: (chunk) => context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk }),
  })
  assertSubagentCanFinalize({ runtime, sandboxReadiness })
  if (generation.status === "aborted")
    throw new DOMException("Subagent stream was aborted.", "AbortError")
  // The parent would read a cut-short answer as complete: it gets the cause instead.
  if (generation.finishReason === "length") {
    const remedy = "Spawn it again with lower reasoning or a narrower task."
    throw withFailureMessage(
      createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Subagent run '${run.id}' reached the model's output limit before finishing its answer. ${remedy}`,
        { details: { parentRunId: run.parentRunId, runId: run.id } }
      ),
      `The subagent's model reached its output limit before finishing its answer. ${remedy}`
    )
  }
  const parts = agentTraceFromModelSteps(generation.steps, {
    parentRunId: run.parentRunId,
    runId: run.id,
  })
  const childResult = subagentResult(parts, run)

  const finalized = await finishRunOrThrow(context.storage.agents, {
    projectId: context.id,
    id: run.id,
    executionToken,
    status: "succeeded",
    modelId: plan.model.modelId,
    finishReason: coerceAgentRunFinishReason(generation.finishReason) ?? "unknown",
    result: childResult,
  })
  if (finalized.kind !== "subagent") {
    throw new Error(`[SixbAgentWorker] Subagent run '${run.id}' changed kind during finalization.`)
  }
  await context.streamSink.publishRunFinished(finalized)
  return finalized
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
  if (!text) {
    throw createSixbError(
      "agent.execution_failed",
      `[SixbAgentWorker] Subagent run '${run.id}' produced no final text.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }
  return { text }
}
