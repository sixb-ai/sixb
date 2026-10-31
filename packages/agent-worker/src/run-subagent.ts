import type { AgentMessagePart } from "@sixb/core"
import {
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
  runModelLoop,
  toModelMessages,
} from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"
import type { ModelMessage, ModelStep } from "@sixb/core/models"
import {
  type AgentRunFinishReason,
  type AgentThreadRecord,
  type AppendAgentMessageInput,
  coerceAgentRunFinishReason,
  type SubagentRunRecord,
} from "@sixb/core/storage"
import { DEFAULT_AGENT_FINAL_STEP_INSTRUCTION, renderCurrentTime } from "./agent-prompt"
import { unansweredQuestion } from "./ask-parent-tool"
import { attachmentKey, toolResultAttachmentKey } from "./attachments"
import { storeChildOutputs } from "./child-files"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import type { SubagentHistory } from "./subagent-continuation"
import type { SubagentDelivery, SubagentInbox } from "./subagent-inbox"
import type { AgentTurnRuntime } from "./turn-runtime"
import type { AgentRunFiles, AgentTurnContext } from "./types"

/**
 * What a child did so far, kept in its thread however its run ends: a failed or stopped child
 * keeps it as an interrupted turn does. Its steps, and each message its parent sent it where it
 * read it.
 */
export interface SubagentWork {
  messages?: readonly AppendAgentMessageInput[]
}

/**
 * Run one child in its thread. Its request is the thread's messages, the task dated at the thread's
 * creation; what it did is the thread's next message, written with its finish. A held call stops it
 * after that step: it pauses, and its thread's next run continues it once the call is decided.
 */
export async function runSubagent(input: {
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly run: SubagentRunRecord
  /** The child's session: its finish is fenced by the run's execution token. */
  readonly session: AgentRunSession
  /** The child's own thread, and what its runs before this one left there. */
  readonly thread: AgentThreadRecord
  readonly history: SubagentHistory
  /** Created by the worker before the run's tools, which share its signal and accounting. */
  readonly runtime: AgentTurnRuntime
  /** Filled once the model loop returns, for the worker to keep when the run fails afterwards. */
  readonly work?: SubagentWork
  /** Where it finds the files its parent handed over, and leaves the ones it returns. */
  readonly runFiles: AgentRunFiles
  /**
   * What its parent sends it while it runs, read before its next step, and the questions it asks,
   * through the inbox's `ask_parent` among its tools.
   */
  readonly inbox: SubagentInbox
}): Promise<SubagentRunRecord> {
  const { context, plan, run, thread, runtime, inbox } = input
  const messages = subagentModelMessages({
    context,
    thread,
    history: input.history,
    timeZone: plan.timeZone ?? context.projectTimeZone,
  })
  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  let chunkIndex = 0
  const generation = await runModelLoop({
    model: runtime.usageRecorder.wrapModel(plan.model),
    messages: [{ role: "system", content: context.systemPrompt }, ...messages],
    tools: context.tools,
    ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
    maxSteps: plan.maxSteps,
    finalStepInstruction: DEFAULT_AGENT_FINAL_STEP_INSTRUCTION,
    // A message from the parent comes after the step that was running when it arrived, and stays
    // in the history of every later step.
    prepareStep: async (step) => {
      const prepared = await context.prepareStep?.(step)
      const mail = await inbox.take(step.stepIndex)
      if (!mail) return prepared

      return { messages: [...(prepared?.messages ?? step.messages), ...toModelMessages([mail])] }
    },
    // One that arrives as the child answers is read too: it writes its result again, after it.
    beforeComplete: async (_step, stepIndex) => {
      const mail = await inbox.take(stepIndex + 1, { afterAnswer: true })
      return mail ? toModelMessages([mail]) : undefined
    },
    signal: abortSignal,
    onModelCallEnd: runtime.usageRecorder.onModelCallEnd,
    onEvent: (chunk) =>
      input.session.events.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk }),
    // The approval records decide, never the prompt or the tool output: a held call stops the
    // child after that step, whatever its model would do next. So does a question its parent's
    // turn ended without answering.
    pauseAfterStep: async () =>
      inbox.deferred !== undefined || (await input.session.heldCalls.holdsRun()),
  })
  const work = subagentWorkMessages(generation, run, inbox.deliveries)
  if (input.work) input.work.messages = work

  return settleSubagent({
    ...input,
    generation,
    work,
    abortSignal,
    sandboxReadiness,
    lastMessageAt: inbox.deliveries.at(-1)?.afterSteps ?? 0,
  })
}

/** End a child whose model loop returned: paused on its held calls, answered, or failed. */
async function settleSubagent(
  input: Omit<Parameters<typeof finishSubagent>[0], "finishReason" | "text"> & {
    readonly generation: PausableModelLoopResult
    readonly sandboxReadiness: ReturnType<typeof monitorSandboxReadiness>
    /** Whether the child paused on its question. */
    readonly inbox: SubagentInbox
    /** After how many steps it read its parent's last message. */
    readonly lastMessageAt: number
  }
): Promise<SubagentRunRecord> {
  const { generation, run } = input
  assertSubagentCanFinalize(input)
  if (generation.status === "aborted")
    throw new DOMException("Subagent stream was aborted.", "AbortError")

  // A call held after its last step, by a command left running in the sandbox, pauses it too. A
  // held call wins over a question: only a decision continues it, and it can ask again then.
  const asked = input.inbox.deferred !== undefined
  const held =
    (generation.status === "paused" && !asked) || (await input.session.heldCalls.holdsRun())
  if (held) {
    // Its question then goes unanswered: the decision continues it.
    const work = asked ? unansweredQuestion(input.work) : input.work
    return finishSubagent({ ...input, work, finishReason: "awaiting_approval" })
  }
  if (generation.status === "paused" || asked) {
    return finishSubagent({ ...input, finishReason: "awaiting_answer" })
  }

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
  return finishSubagent({
    ...input,
    text: subagentResult(generation.steps, run, input.lastMessageAt),
    finishReason: coerceAgentRunFinishReason(generation.finishReason) ?? "unknown",
  })
}

/**
 * Keep the child's outcome: its answer, what it wrote under `out/`, and what it did as its thread's
 * next message. A paused child keeps its files too, for the run that continues it; `wait_agent`
 * hands over only a finished child's, as an unfinished one's would pass for complete. Its `out/`
 * is stored even when its workspace is kept: a continuation that finds it lost gets it back.
 */
async function finishSubagent(input: {
  readonly context: AgentTurnContext
  readonly plan: ResolvedAgentExecutionPlan
  readonly run: SubagentRunRecord
  readonly runtime: AgentTurnRuntime
  readonly runFiles: AgentRunFiles
  readonly session: AgentRunSession
  readonly abortSignal: AbortSignal
  readonly finishReason: AgentRunFinishReason
  readonly work: readonly AppendAgentMessageInput[]
  /** None yet for a paused child. */
  readonly text?: string
}): Promise<SubagentRunRecord> {
  const { context, run } = input
  const outputs = await storeChildOutputs({
    files: input.runFiles,
    handed: run.spec.files ?? [],
    signal: input.abortSignal,
  })
  input.runtime.assertCanContinue()

  // Before the terminal write, and after out/ was read: a paused child's workspace is kept for
  // the run that continues it, and one that answered goes.
  const paused =
    input.finishReason === "awaiting_approval" || input.finishReason === "awaiting_answer"
  await context.beforeFinalize?.({ discard: !paused })
  input.runtime.assertCanContinue()

  const finalized = await input.session.finish(
    {
      status: "succeeded",
      modelId: input.plan.model.modelId,
      finishReason: input.finishReason,
      result: {
        text: input.text ?? "",
        ...(outputs.files.length > 0 ? { files: outputs.files } : {}),
        ...(outputs.error === undefined ? {} : { filesError: outputs.error }),
      },
    },
    input.work
  )
  if (finalized.kind !== "subagent") {
    throw new Error(`[SixbAgentWorker] Subagent run '${run.id}' changed kind during finalization.`)
  }
  await input.session.events.publishRunFinished(finalized)
  return finalized
}

/**
 * What a child run did, as the messages its thread keeps: its steps, the one cut short included,
 * and each message its parent sent it, where it read it. Each has the run's id.
 */
function subagentWorkMessages(
  generation: PausableModelLoopResult,
  run: SubagentRunRecord,
  deliveries: readonly SubagentDelivery[]
): readonly AppendAgentMessageInput[] {
  const details = { threadId: run.threadId, runId: run.id }
  const messages: AppendAgentMessageInput[] = []
  const push = (role: "user" | "assistant", parts: readonly AgentMessagePart[]) => {
    messages.push({
      id: createAgentMessageId(),
      projectId: run.projectId,
      threadId: run.threadId,
      runId: run.id,
      role,
      parts,
    })
  }
  const pushSteps = (parts: readonly AgentMessagePart[]) => {
    if (parts.some((part) => part.type !== "step-start")) push("assistant", parts)
  }

  let from = 0
  for (const delivery of deliveries) {
    pushSteps(agentTraceFromModelSteps(generation.steps.slice(from, delivery.afterSteps), details))
    push("user", delivery.parts)
    from = delivery.afterSteps
  }

  const rest = generation.steps.slice(from)
  pushSteps(
    generation.status === "aborted"
      ? agentTraceFromPartialModelLoop(rest, generation.partialContent, details)
      : agentTraceFromModelSteps(rest, details)
  )
  return messages
}

/**
 * The child's thread as its model reads it. The task, its first message, closes with the time the
 * thread was created, so each run of the child replays the same bytes. Files a tool showed it are
 * projected again as a turn projects its own.
 */
function subagentModelMessages(input: {
  readonly context: AgentTurnContext
  readonly thread: AgentThreadRecord
  readonly history: SubagentHistory
  readonly timeZone: string
}): ModelMessage[] {
  const { messages } = input.history
  const projections = input.context.attachmentContext
  const taskId = messages[0]?.id
  const createdAt = renderCurrentTime(input.thread.createdAt, input.timeZone)

  return toModelMessages(messages, {
    userMessageSuffix: (message) => (message.id === taskId ? createdAt : undefined),
    fileText: ({ message, partIndex }) =>
      projections?.promptTextByPartKey.get(attachmentKey(message.id, partIndex)),
    fileData: ({ message, partIndex }) =>
      projections?.modelFileDataByPartKey.get(attachmentKey(message.id, partIndex)),
    toolResultFileText: ({ message, partIndex, contentIndex }) =>
      projections?.promptTextByPartKey.get(
        toolResultAttachmentKey(message.id, partIndex, contentIndex)
      ),
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
function subagentResult(
  steps: readonly ModelStep[],
  run: SubagentRunRecord,
  lastMessageAt: number
): string {
  const text = subagentAnswer(steps, lastMessageAt)
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
 * continuation, and after the last message its parent sent it (read after `lastMessageAt` steps),
 * which an answer written before it no longer answers. Without any, the last text it wrote, such
 * as an answer it gave before a final tool call. Narration written before earlier tool calls never
 * reaches the parent.
 */
export function subagentAnswer(steps: readonly ModelStep[], lastMessageAt = 0): string {
  const ranLocalTools = steps.map((step) =>
    step.content.some((part) => part.type === "tool-call" && part.providerExecuted !== true)
  )
  const answer = textOf(steps.slice(Math.max(ranLocalTools.lastIndexOf(true) + 1, lastMessageAt)))
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
