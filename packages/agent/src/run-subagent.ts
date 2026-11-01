import type { AgentMessagePart } from "@sixb/core"
import {
  type AgentRunSession,
  createAgentMessageId,
  type PausableModelLoopResult,
  runModelLoop,
  toModelMessages,
} from "@sixb/core/internal/agents"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import type { ModelMessage, ModelStep } from "@sixb/core/models"
import {
  type AgentRunFinishReason,
  type AgentThreadRecord,
  type AppendAgentMessageInput,
  coerceAgentRunFinishReason,
  type SubagentRunRecord,
} from "@sixb/core/storage"
import { renderCurrentTime, sentSettings } from "./agent-prompt"
import { unansweredQuestion } from "./ask-parent-tool"
import { storeChildOutputs } from "./child-files"
import {
  type AgentContextBudget,
  expectedRemainingAgentCalls,
  resolveAgentContextTarget,
} from "./context-budget"
import { createAgentContextGuard } from "./context-guard"
import { throwIfExecutionLost } from "./errors"
import type { ResolvedAgentExecutionPlan } from "./execution-plan"
import { agentTraceFromModelSteps, agentTraceFromPartialModelLoop } from "./model-adapters"
import { markReducedSteps } from "./run-agent-turn"
import type { SubagentAgentExecutionEnvironment } from "./run-environment"
import { monitorSandboxReadiness } from "./sandbox-readiness"
import {
  type SubagentThreadContext,
  subagentContextFailure,
  subagentModelMessages,
  subagentPromptCaching,
} from "./subagent-context"
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
  /**
   * The limits every call of the child keeps under, what its environment's preflight left of its
   * thread, and how it compacts that thread from within.
   */
  readonly contextLimits: {
    readonly budget: AgentContextBudget
    readonly thread: SubagentThreadContext
    readonly compactInRun?: SubagentAgentExecutionEnvironment["compactInRun"]
    readonly bytesPerToken?: number
  }
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
  const { budget, compactInRun, bytesPerToken } = input.contextLimits
  const caching = subagentPromptCaching({
    projectId: context.id,
    thread,
    run,
    history: input.history,
  })
  const createdAt = renderCurrentTime(
    thread.createdAt,
    sentSettings(plan, { timeZone: context.projectTimeZone, locale: context.projectLocale })
  )
  const messages: ModelMessage[] = [
    { role: "system", content: context.systemPrompt },
    ...subagentModelMessages({
      thread: input.contextLimits.thread,
      ...(context.attachmentContext ? { attachmentContext: context.attachmentContext } : {}),
      createdAt,
    }),
  ]
  const guard = createAgentContextGuard({
    budget,
    targetTokens: resolveAgentContextTarget(budget, {
      expectedRemainingCalls: expectedRemainingAgentCalls(input.history),
    }).tokens,
    tools: context.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...(bytesPerToken === undefined ? {} : { bytesPerToken }),
    ...(compactInRun
      ? {
          compact: async (compacting) => {
            const request = await compactInRun(compacting)
            return (
              request && [
                { role: "system" as const, content: request.systemPrompt },
                ...request.messages,
              ]
            )
          },
        }
      : {}),
  })
  const sandboxReadiness = monitorSandboxReadiness(context.sandboxReady)
  const abortSignal = AbortSignal.any([runtime.signal, sandboxReadiness.signal])
  let chunkIndex = 0
  const generation = await runModelLoop({
    model: plan.model,
    messages,
    tools: context.tools,
    ...(plan.reasoning === undefined ? {} : { reasoning: plan.reasoning }),
    caching,
    // A message from the parent comes after the step that was running when it arrived, and stays
    // in the history of every later step. The guard weighs the step before it: what it compacts
    // is the history the run started from, never what the parent sent it since.
    prepareStep: async (step) => {
      const prepared = await context.prepareStep?.(step)
      const guarded = await guard.prepareStep({
        ...step,
        messages: prepared?.messages ?? step.messages,
      })
      const mail = await inbox.take(step.stepIndex)
      if (!mail) return guarded ?? prepared

      return {
        messages: [
          ...(guarded?.messages ?? prepared?.messages ?? step.messages),
          ...toModelMessages([mail]),
        ],
      }
    },
    recoverStep: guard.recoverStep,
    // One that arrives as the child answers is read too: it writes its result again, after it.
    beforeComplete: async (_step, stepIndex) => {
      const mail = await inbox.take(stepIndex + 1, { afterAnswer: true })
      return mail ? toModelMessages([mail]) : undefined
    },
    signal: abortSignal,
    onEvent: (chunk) =>
      input.session.events.publishUiChunk({ run, chunkIndex: chunkIndex++, chunk }),
    // The approval records decide, never the prompt or the tool output: a held call stops the
    // child after that step, whatever its model would do next. So does a question its parent's
    // turn ended without answering.
    pauseAfterStep: async () =>
      inbox.deferred !== undefined || (await input.session.heldCalls.holdsRun()),
  }).catch((error: unknown) => {
    throw subagentContextFailure(error, run) ?? error
  })
  const work = subagentWorkMessages(generation, run, inbox.deliveries, guard.reducedFromStep())
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
        `[SixbAgent] Subagent run '${run.id}' reached the model's output limit before finishing its answer. ${remedy}`,
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
  readonly inbox: SubagentInbox
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
  // A paused child stops reading here: what came and it never read goes on with the run that
  // continues it, as that run's first message.
  const unread = paused ? input.inbox.close() : []
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
        ...(unread.length > 0 ? { unread } : {}),
      },
    },
    input.work
  )
  if (finalized.kind !== "subagent") {
    throw new Error(`[SixbAgent] Subagent run '${run.id}' changed kind during finalization.`)
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
  deliveries: readonly SubagentDelivery[],
  /** The first step whose request the guard reduced: it and those after it are marked so. */
  reducedFromStep: number | undefined
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
  // Steps from `from` on, the ones whose request was reduced marked so.
  const pushSteps = (parts: readonly AgentMessagePart[], from: number) => {
    const marked = markReducedSteps(
      parts,
      reducedFromStep === undefined ? undefined : reducedFromStep - from
    )
    if (marked.some((part) => part.type !== "step-start")) push("assistant", marked)
  }

  let from = 0
  for (const delivery of deliveries) {
    pushSteps(
      agentTraceFromModelSteps(generation.steps.slice(from, delivery.afterSteps), details),
      from
    )
    push("user", delivery.parts)
    from = delivery.afterSteps
  }

  const rest = generation.steps.slice(from)
  pushSteps(
    generation.status === "aborted"
      ? agentTraceFromPartialModelLoop(rest, generation.partialContent, details)
      : agentTraceFromModelSteps(rest, details),
    from
  )
  return messages
}

function assertSubagentCanFinalize(input: {
  readonly runtime: AgentTurnRuntime
  readonly sandboxReadiness: ReturnType<typeof monitorSandboxReadiness>
}): void {
  throwIfExecutionLost(input.runtime.sourceSignal)
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
        `[SixbAgent] Subagent run '${run.id}' finished without an answer. ${remedy}`,
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
