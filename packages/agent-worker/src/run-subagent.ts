import { runModelLoop } from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { ModelStep } from "@sixb/core/models"
import { coerceAgentRunFinishReason, type SubagentRunRecord } from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION, withCurrentTime } from "./agent-prompt"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { finishRunOrThrow } from "./finalize"
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
        plan.timeZone ?? context.projectTimeZone
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
  const childResult = subagentResult(generation.steps, run)

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

/** The child's answer, or a failure that tells the parent what to do about none. */
function subagentResult(
  steps: readonly ModelStep[],
  run: SubagentRunRecord
): NonNullable<SubagentRunRecord["result"]> {
  const text = subagentAnswer(steps)
  if (!text) {
    const remedy = "Spawn it again with a task that says what its answer must contain."
    throw withFailureMessage(
      createSixbError(
        "agent.execution_failed",
        `[SixbAgentWorker] Subagent run '${run.id}' finished without an answer. ${remedy}`,
        { details: { parentRunId: run.parentRunId, runId: run.id } }
      ),
      `The subagent finished without an answer. ${remedy}`
    )
  }
  return { text }
}

/**
 * What the child answers: the text it wrote once its last local tool returned, through any provider
 * continuation. Without any, the last text it wrote, such as an answer it gave before a final tool
 * call. Narration written before earlier tool calls never reaches the parent.
 */
export function subagentAnswer(steps: readonly ModelStep[]): string {
  const ranLocalTools = steps.map((step) =>
    step.content.some((part) => part.type === "tool-call" && part.providerExecuted !== true)
  )
  const answer = textOf(steps.slice(ranLocalTools.lastIndexOf(true) + 1))
  if (answer) return answer

  const written = steps.map((step) => textOf([step])).filter(Boolean)
  return written.at(-1) ?? ""
}

function textOf(steps: readonly ModelStep[]): string {
  return steps
    .flatMap((step) => step.content)
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}
