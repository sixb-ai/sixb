import type { AgentMessagePart } from "@sixb/core"
import { createAgentMessageId, runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { ModelMessage, ModelStep } from "@sixb/core/models"
import {
  type AgentThreadRecord,
  type AppendAgentMessageInput,
  coerceAgentRunFinishReason,
  type SubagentRunRecord,
} from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION, renderCurrentTime } from "./agent-prompt"
import { type AgentRunWorkspace, storeChildOutputs } from "./child-files"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { appendMessageAndFinishRunOrThrow } from "./finalize"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentTurnContext } from "./types"

/**
 * What a child did so far, kept in its thread however its run ends: a failed or stopped child
 * keeps it as an interrupted turn does.
 */
export interface SubagentWork {
  parts?: readonly AgentMessagePart[]
}

/**
 * Run one child in its thread. Its request is the thread's messages, the task dated at the thread's
 * creation; what it did is the thread's next message, written with its finish.
 */
export async function runSubagent(input: {
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly run: SubagentRunRecord
  /** The child's own thread. */
  readonly thread: AgentThreadRecord
  /** Created by the worker before the run's tools, which share its signal and accounting. */
  readonly runtime: AgentTurnRuntime
  /** Filled once the model loop returns, for the worker to keep when the run fails afterwards. */
  readonly work?: SubagentWork
  /** Where it finds the files its parent handed over, and leaves the ones it returns. */
  readonly workspace: AgentRunWorkspace
}): Promise<SubagentRunRecord> {
  const { context, plan, run, thread, runtime } = input
  const executionToken = run.execution?.token
  if (!executionToken) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Subagent run '${run.id}' has no execution token.`,
      { details: { parentRunId: run.parentRunId, runId: run.id } }
    )
  }

  const history = await subagentHistory({
    context,
    thread,
    timeZone: plan.timeZone ?? context.projectTimeZone,
  })
  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  let chunkIndex = 0
  const generation = await runModelLoop({
    model: runtime.usageRecorder.wrapModel(plan.model),
    messages: [{ role: "system", content: context.systemPrompt }, ...history],
    tools: context.tools,
    ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
    maxSteps: plan.maxSteps,
    finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
    ...(context.prepareStep === undefined ? {} : { prepareStep: context.prepareStep }),
    signal: abortSignal,
    onModelCallEnd: runtime.usageRecorder.onModelCallEnd,
    onEvent: (chunk) => context.streamSink.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk }),
  })
  const traceDetails = { threadId: run.threadId, runId: run.id }
  const parts =
    generation.status === "aborted"
      ? agentTraceFromPartialModelLoop(generation.steps, generation.partialContent, traceDetails)
      : agentTraceFromModelSteps(generation.steps, traceDetails)
  if (input.work) input.work.parts = parts

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
  const text = subagentResult(generation.steps, run)
  // Only a child that finished returns files: an unfinished one's would pass for complete.
  const files = await storeChildOutputs({
    workspace: input.workspace,
    handed: run.spec.files ?? [],
    runId: run.id,
    parentRunId: run.parentRunId,
    signal: abortSignal,
  })
  runtime.assertCanContinue()

  const finalized = await appendMessageAndFinishRunOrThrow(context.storage, {
    message: subagentWorkMessage(run, parts),
    finish: {
      projectId: context.id,
      id: run.id,
      executionToken,
      status: "succeeded",
      modelId: plan.model.modelId,
      finishReason: coerceAgentRunFinishReason(generation.finishReason) ?? "unknown",
      result: { text, ...(files.length > 0 ? { files } : {}) },
    },
  })
  if (finalized.kind !== "subagent") {
    throw new Error(`[SixbAgentWorker] Subagent run '${run.id}' changed kind during finalization.`)
  }
  await context.streamSink.publishRunFinished(finalized)
  return finalized
}

/** The assistant message that keeps what a child run did in its thread. */
export function subagentWorkMessage(
  run: SubagentRunRecord,
  parts: readonly AgentMessagePart[]
): AppendAgentMessageInput {
  return {
    id: createAgentMessageId(),
    projectId: run.projectId,
    threadId: run.threadId,
    runId: run.id,
    role: "assistant",
    parts,
  }
}

/**
 * The child's thread as its model reads it. The task, its first message, closes with the time the
 * thread was created, so each run of the child replays the same bytes.
 */
async function subagentHistory(input: {
  readonly context: AgentTurnContext
  readonly thread: AgentThreadRecord
  readonly timeZone: string
}): Promise<ModelMessage[]> {
  const { context, thread } = input
  const { messages } = await context.storage.agents.messages.list({
    projectId: context.id,
    threadId: thread.id,
    order: "asc",
  })
  const taskId = messages[0]?.id
  const createdAt = renderCurrentTime(thread.createdAt, input.timeZone)

  return toModelMessages(messages, {
    userMessageSuffix: (message) => (message.id === taskId ? createdAt : undefined),
  })
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
function subagentResult(steps: readonly ModelStep[], run: SubagentRunRecord): string {
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
  return text
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
