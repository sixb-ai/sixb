import { isDeepStrictEqual } from "node:util"
import {
  AGENT_REASONING_LEVELS,
  type AgentApprovalOutcomePart,
  type AgentMailPart,
  type AgentMessage,
  type AgentMessagePart,
  type AgentReasoning,
  AgentToolPublicError,
  type AgentToolResult,
  type LanguageModelCatalog,
  type LanguageModelRef,
  type LanguageModelTier,
} from "@sixb/core"
import {
  createInheritedAgentExecutionRecord,
  ensureExecutionRecord,
} from "@sixb/core/internal/agent-execution"
import {
  type AgentChildApprovalAwaiting,
  createAgentMessageId,
  createSubagentExecutionId,
  createSubagentRunId,
  createSubagentThreadId,
  deferredChildQuestion,
  dispatchQueuedSubagentRuns,
  hasActiveChildren,
  isAgentToolResult,
  isAwaitingAnswerRun,
  isPausedSubagentRun,
  listChildApprovalsAwaiting,
  listSubagentThreadRuns,
  publishAgentMail,
} from "@sixb/core/internal/agents"
import { formatLanguageModelTiers, isLanguageModelTier } from "@sixb/core/internal/model-execution"
import {
  assertJsonValue,
  defineLanguageModel,
  isJsonObject,
  isModelReasoning,
  type JsonObject,
  type ModelTool,
} from "@sixb/core/models"
import type {
  ConversationAgentRunRecord,
  CreateSubagentRunInput,
  ExecutionRecord,
  SubagentRunFile,
  SubagentRunRecord,
  SubagentRunSpec,
} from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { delay } from "./abort"
import { renderHandedFiles } from "./agent-prompt"
import { formatBytes, SANDBOX_ATTACHMENT_LIMITS } from "./attachments"
import {
  CHILD_FILES_DIRECTORY,
  handedFileRefs,
  type InstalledChildFile,
  installChildOutputs,
  listHandedSources,
  storeHandedFiles,
} from "./child-files"
import {
  type ChildQuestion,
  ChildQuestions,
  type QuestionRef,
  renderChildQuestions,
} from "./child-questions"
import { agentToolErrorText } from "./model-adapters"
import { renderModelLine } from "./model-lines"
import type { TurnChildren } from "./run-agent-turn"
import { continuationTrigger } from "./subagent-continuation"
import type { AgentRunFiles, AgentWorkerContext, AgentWorkerHost } from "./types"

/**
 * How long a wait for children goes without reading their runs when nothing woke it. A child's
 * finish and a question wake it at once, through the turn's inbox; this only bounds what a lost
 * wake costs: a record the broker dropped, a subscription that failed. Five seconds keeps such a
 * loss short beside the minutes a child works, and a wait reads storage 12 times a minute.
 */
export const CHILD_WAIT_RECHECK_MS = 5_000
/**
 * How often a wait reads a run whose finish goes to another run's inbox, which nothing wakes it
 * for: a child of an earlier turn, or of an earlier attempt of this resume, still stopping. Both
 * are rare and short, so a short poll costs little.
 */
export const OTHER_INBOX_RECHECK_MS = 250
/**
 * How long before its turn's deadline `wait_agent` stops waiting, so the Agent still answers with
 * what its children found. A last step without tools takes seconds on a light model and up to about
 * a minute on a heavy one with high reasoning; a turn has ten minutes by default.
 */
export const WAIT_ANSWER_MARGIN_MS = 60_000

const OMIT_MODEL = "Omit model to use the project default."

/** With tiers, the model guide says how to choose, so only a list adds advice. */
const TIERED_MODEL_CHOICE = {
  advice: [],
  field: "A tier, or one exact model reference from the models you can delegate to.",
}

const LISTED_MODEL_CHOICE = {
  advice: [
    "Prefer the default model unless another configured model is clearly better suited to the task. Price and runtime speed are not known, so do not infer them from model names.",
  ],
  field: "Copy one exact model reference from the available models.",
}

export interface SpawnSubagentInput {
  readonly key: string
  readonly task: string
  readonly model?: LanguageModelRef | LanguageModelTier
  readonly reasoning?: AgentReasoning
  /** Files and directories in the parent's sandbox, copied into the child's at the same paths. */
  readonly files?: readonly string[]
}

export interface SpawnSubagentOutput {
  readonly runId: string
  readonly status: SubagentRunRecord["status"]
  readonly model: LanguageModelRef
}

export interface MessageSubagentInput {
  readonly key: string
  readonly text: string
}

export interface MessageSubagentOutput {
  readonly runId: string
  readonly status: "queued" | "running"
  /**
   * When the child reads it: before its first step while it is queued, else before its next.
   * `answer`: it answers the question the child waits on, now or, once it continues, first.
   */
  readonly delivery: "first-step" | "next-step" | "answer"
  /** The child of an earlier turn, paused on its question, that this answer continues. */
  readonly continues?: string
}

/** A message the parent sent a child this turn. */
interface SentMessage {
  readonly id: string
  readonly text: string
}

export interface WaitForSubagentsInput {
  readonly runIds: readonly string[]
}

export interface WaitedSubagentResult {
  readonly runId: string
  /**
   * `queued` or `running`: the turn is about to end, so the Agent answers without it.
   * `awaiting_approval`: it paused on calls that wait for the user, and continues once they decide,
   * unless a new message sets the calls aside or the turn is stopped instead.
   */
  readonly status: SubagentRunRecord["status"] | "awaiting_approval" | "awaiting_answer"
  readonly text?: string
  /** The question it waits on: answer it with `message_agent` and its key. */
  readonly question?: QuestionRef
  readonly error?: { readonly code: string; readonly message: string }
  /** Calls it made that wait for the user's approval. */
  readonly awaitingApproval?: readonly AgentChildApprovalAwaiting[]
  /**
   * What it wrote under `out/`, by path there, and where each is in the parent's sandbox this
   * turn. The first result that lists them holds them as files, which later turns find in
   * `$SIXB_ATTACHMENTS` by their `logicalPath`, `<key>/<path>`.
   */
  readonly files?: readonly {
    readonly path: string
    readonly sandboxPath: string
    readonly sizeBytes: number
    readonly mediaType?: string
  }[]
  /** Why its files are not listed: they did not come back, could not be copied, or wait. */
  readonly filesNote?: string
  /** What this turn sent it that it has not read: a paused child reads it if it continues. */
  readonly unread?: readonly SentMessage[]
  /**
   * What it answered before a message of yours came, which its `text`, written after, replaces.
   * Set when it answered again.
   */
  readonly earlierAnswer?: string
  /** Why its `text` does not account for your last message, when it did not answer again. */
  readonly answerNote?: string
}

type MessagesReport = Pick<WaitedSubagentResult, "unread" | "earlierAnswer" | "answerNote">

/** A question a child waits on, with the key to answer it by. */
export interface WaitedQuestion extends QuestionRef {
  readonly key: string
  readonly runId: string
}

export interface WaitForSubagentsOutput {
  readonly results: readonly WaitedSubagentResult[]
  /** Every question a child of this turn waits on: `wait_agent` returns as soon as one comes. */
  readonly questions?: readonly WaitedQuestion[]
  /** The files no earlier result held, in the order of `results`. */
  readonly files: readonly InstalledChildFile[]
  /** Why what the children published is not all in `$SIXB_ARTIFACTS`. */
  readonly artifactsError?: string
}

/** Run-scoped boundary used by the parent Agent's framework-owned delegation tools. */
export class SubagentCoordinator {
  private readonly models: LanguageModelCatalog
  #runFiles: AgentRunFiles | undefined
  /** Children whose files are in the parent's sandbox, and in the result that first listed them. */
  readonly #installed = new Map<string, readonly InstalledChildFile[]>()
  /** The spawn being admitted: only this turn adds children to it. */
  #admissions: Promise<unknown> = Promise.resolve()
  /** What this turn sent each child, by its run id, in order. */
  readonly #sent = new Map<string, SentMessage[]>()
  readonly #questions: ChildQuestions
  /** The questions a `wait_agent` returned: one alone no longer stops a wait for other children. */
  readonly #reported = new Set<string>()
  /** What each `message_agent` that answered a question returned, by its mail id, for a replay. */
  readonly #answers = new Map<string, MessageSubagentOutput>()

  constructor(
    private readonly host: AgentWorkerHost,
    private readonly context: AgentWorkerContext,
    private readonly parentRun: ConversationAgentRunRecord,
    private readonly parentExecution: ExecutionRecord,
    /** When the parent turn times out: no child outlives it. */
    private readonly parentDeadline: Date
  ) {
    const models = host.definitions.models?.language
    if (!models) {
      throw new Error("[SixbAgentWorker] Subagent delegation requires a language model catalog.")
    }
    this.models = models
    this.#questions = new ChildQuestions(host.broker, context.id, parentRun.id)
  }

  /** Stop listening for the children's questions, once the turn ended. */
  close(): void {
    this.#questions.close()
  }

  /**
   * How the turn hears its children's questions: those of earlier turns' children still paused on
   * one, read after the conversation; those it has not read, before its answer ends it; and the
   * pause, before its end, of each child still waiting on one. And how a pausing turn waits for
   * those still at work.
   */
  async turnChildren(): Promise<TurnChildren> {
    let waiting: readonly WaitedQuestion[] = []
    try {
      waiting = await this.waitingQuestions()
    } catch (error) {
      console.error(
        `[SixbAgentWorker] Agent run '${this.parentRun.id}' could not read which earlier sub-agents wait on a question; it goes on without them.`,
        error
      )
    }
    return {
      ...(waiting.length > 0 ? { waiting: renderChildQuestions(waiting, { earlier: true }) } : {}),
      unread: async () => {
        const unread = await this.unreadQuestions()
        return unread.length > 0 ? renderChildQuestions(unread) : undefined
      },
      defer: (stopAt, signal) => this.deferOpenQuestions(stopAt, signal),
      settle: (stopAt, signal) => this.settleChildren(stopAt, signal),
    }
  }

  /** The parent's environment, started after its tools are defined and before any of them runs. */
  attach(runFiles: AgentRunFiles): void {
    this.#runFiles = runFiles
  }

  /**
   * When this turn resumes a paused one, continue each child that paused on its held calls: the
   * next run of its thread, under this turn and the same key, with the paused child's model, task
   * and files, and this turn's mode and deadline. The outcomes of its calls start the run. Admitting
   * it again finds it, so a retry of this turn, under its own id, admits its own.
   */
  async continuePausedChildren(signal: AbortSignal): Promise<void> {
    const paused = await this.pausedChildrenToContinue()
    for (const { child, outcomes } of paused) {
      signal.throwIfAborted()
      await this.clearDeadAttempts(child, signal)
      const { spec, continuation } = this.continuationOf(child, outcomes)
      await this.admitInTurn(() =>
        this.admit(
          createSubagentRunId(this.parentRun.id, child.spawnKey),
          child.spawnKey,
          spec,
          signal,
          {
            ...continuation,
            // Each was admitted within the limit; the turn starts with all of them at once.
            maxActiveChildren: Math.max(this.context.subagentConcurrencyPerRun, paused.length),
          }
        )
      )
    }
  }

  /**
   * Remove from a paused child's thread what the runs after its pause did under an earlier attempt
   * of this resume, which failed: this turn continues the paused child again, as a retried turn
   * replays from its trigger. A run still stopping is waited for, until shortly before this turn's
   * deadline.
   */
  private async clearDeadAttempts(paused: SubagentRunRecord, signal: AbortSignal): Promise<void> {
    const { agents } = this.context.storage
    const projectId = this.context.id
    const stopAt = this.parentDeadline.getTime() - WAIT_ANSWER_MARGIN_MS

    for (;;) {
      const runs = await listSubagentThreadRuns(agents, { projectId, threadId: paused.threadId })
      const pausedAt = runs.findIndex((run) => run.id === paused.id)
      const dead = (pausedAt < 0 ? [] : runs.slice(pausedAt + 1)).filter(
        (run) => run.parentRunId !== this.parentRun.id
      )
      const stopping = dead.filter((run) => !isTerminalSubagent(run))
      if (stopping.length === 0) {
        for (const run of dead) {
          await agents.messages.deleteByRunId({
            projectId,
            threadId: paused.threadId,
            runId: run.id,
          })
        }
        return
      }

      const remainingMs = stopAt - Date.now()
      if (remainingMs <= 0) {
        throw new Error(
          `[SixbAgentWorker] Sub-agent '${paused.spawnKey}' cannot continue: its run '${stopping[0]?.id}' from an earlier attempt of this turn is still stopping.`
        )
      }
      // Its finish goes to the inbox of the attempt it ran under, not this turn's: read it again.
      await delay(Math.min(OTHER_INBOX_RECHECK_MS, remainingMs), signal)
    }
  }

  /**
   * The children this turn continues: those its trigger, a resume, reported as continuing, as the
   * model reads it. The approvals, not the message, say which calls are the child's and that this
   * message reported them, and the child must still be paused on them.
   */
  private async pausedChildrenToContinue(): Promise<
    readonly {
      readonly child: SubagentRunRecord
      readonly outcomes: readonly AgentApprovalOutcomePart[]
    }[]
  > {
    const { agents } = this.context.storage
    const projectId = this.context.id
    const trigger = await agents.messages.getById({
      projectId,
      id: this.parentRun.triggerMessageId,
    })
    if (!trigger) return []

    const parts = trigger.parts.filter(
      (part): part is AgentApprovalOutcomePart => part.type === "approval-outcome"
    )
    const callerIds = [
      ...new Set(parts.flatMap((part) => (part.caller?.continues ? [part.caller.runId] : []))),
    ]
    if (callerIds.length === 0) return []

    const continuing = []
    for (const child of await agents.runs.getByIds({ projectId, ids: callerIds })) {
      if (child.kind !== "subagent" || !isPausedSubagentRun(child)) continue

      const { approvals } = await agents.approvals.list({ projectId, runId: child.parentRunId })
      const reported = new Set(
        approvals
          .filter(
            (approval) =>
              approval.callerRunId === child.id && approval.reportedInMessageId === trigger.id
          )
          .map((approval) => approval.id)
      )
      const outcomes = parts
        .filter((part) => reported.has(part.approvalId))
        .map(({ caller: _caller, ...outcome }) => outcome)
      if (outcomes.length > 0) continuing.push({ child, outcomes })
    }
    return continuing
  }

  async createTools(): Promise<readonly ModelTool[]> {
    const spawn: ModelTool<SpawnSubagentInput> = {
      name: "spawn_agent",
      description: [
        "Start an isolated child agent and return immediately.",
        "Use a short, stable key for the same logical delegation so retries cannot duplicate work.",
        renderSubagentModelGuide(this.models),
        ...modelChoice(this.models).advice,
        OMIT_MODEL,
        `Pass files to copy files or directories of your sandbox into the child's, at the same paths, before it starts. What the child writes to out/ comes back with wait_agent's result when it finishes, under ${CHILD_FILES_DIRECTORY}/<key>/ this turn.`,
        `At most ${this.context.subagentConcurrencyPerRun} child agents may be active for this run.`,
      ].join("\n"),
      inputSchema: spawnInputSchema(this.models),
      parseInput: parseSpawnInput,
      execute: async (value, { signal }) => {
        const output = await this.spawn(value, signal)
        assertJsonValue(output)
        return output
      },
      errorText: agentToolErrorText,
    }
    const wait: ModelTool<WaitForSubagentsInput> = {
      name: "wait_agent",
      description: [
        "Wait for previously spawned child agents and return their final text or failure, and the files each wrote to out/, each with its path in your sandbox. Pass every run id whose result is needed.",
        "Shortly before this run must end, it returns children still at work as queued or running, so you can answer with what the others found.",
        "A child paused on calls that wait for the user's approval returns as awaiting_approval, with those calls: it continues once the user decides, unless the user sends a new message or stops instead.",
        "A message you sent a child that it has not read is listed in its unread. When one came as it answered, earlierAnswer holds what it answered before, and text what it wrote after.",
        "It returns as soon as a child of this turn asks you a question, listed in questions with its key, whichever children you wait for: the child waits for your answer, which you give with message_agent.",
      ].join("\n"),
      inputSchema: waitInputSchema(this.context.subagentConcurrencyPerRun),
      parseInput: (value) => parseWaitInput(value, this.context.subagentConcurrencyPerRun),
      // A rich result, so its files reach later turns through $SIXB_ATTACHMENTS and the work trace.
      execute: async (value, { signal }) => {
        const { files, ...answer } = await this.wait(value, signal)
        const output: AgentToolResult = {
          kind: "agentToolResult",
          content: [
            { type: "text", text: JSON.stringify(answer) },
            ...files.map(({ fileRef }) => ({ type: "file" as const, fileRef })),
          ],
        }
        assertJsonValue(output)
        return output
      },
      // The answer lists each file's path this turn; the Agent reads the ones it needs.
      toModelOutput: (output) => ({
        type: "text",
        value: isAgentToolResult(output)
          ? output.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          : JSON.stringify(output),
      }),
      errorText: agentToolErrorText,
    }
    const message: ModelTool<MessageSubagentInput> = {
      name: "message_agent",
      description: [
        "Send a message to a child agent still at work, by the key you spawned it with. It reads the message before its next step, or before its first while it is queued, and its answer accounts for it.",
        "Use it to correct its course, add information it needs, or narrow its task, instead of waiting for an answer you would discard. Then collect its answer with wait_agent as usual.",
        "A child that finished, or paused for the user's approval, cannot read one.",
        "While a child waits on the question it asked you, your message is its answer. A child that wait_agent listed as awaiting_answer, paused on its question when an earlier turn ended, continues where it stopped with your message as its answer.",
      ].join("\n"),
      inputSchema: messageInputSchema(),
      parseInput: parseMessageInput,
      execute: async (value, { signal, callId, toolCallId }) => {
        const output = await this.message(value, `${callId}:${toolCallId}`, signal)
        assertJsonValue(output)
        return output
      },
      errorText: agentToolErrorText,
    }
    return [spawn, wait, message]
  }

  /**
   * Write a message to a child's inbox, its thread's. Its id names this turn, the model call and
   * the tool call in it, so a replay of the call is the same message and the child reads it once,
   * while two calls never share one, whatever ids the provider gives its tool calls.
   */
  async message(
    input: MessageSubagentInput,
    callId: string,
    signal: AbortSignal
  ): Promise<MessageSubagentOutput> {
    signal.throwIfAborted()
    const key = requireNonEmpty("message_agent", input.key, "key", 128)
    const text = requireNonEmpty("message_agent", input.text, "text")
    const sent = { id: `${this.parentRun.id}:${callId}`, text }
    // A replay of the call that answered a question is that answer, sent once.
    const answered = this.#answers.get(sent.id)
    if (answered) return answered

    const { agents } = this.context.storage
    const projectId = this.context.id
    const child = await agents.runs.getById({
      projectId,
      id: createSubagentRunId(this.parentRun.id, key),
    })
    if (!child) {
      const paused = await this.pausedOnQuestion(key)
      if (paused) return this.answerPaused(paused, key, sent, signal)
    }
    if (child?.kind !== "subagent" || child.parentRunId !== this.parentRun.id) {
      throw new AgentToolPublicError(
        (await this.latestChildUnder(key))
          ? `[SixbAgentWorker] '${key}' is a child agent of an earlier turn, which ended with it. Spawn it again in this turn, with the same key if you like, and message it then.`
          : `[SixbAgentWorker] '${key}' is not a child agent of this turn. Use the key you passed to spawn_agent.`
      )
    }
    // Once its call is filed it pauses at the end of its step, before it would read a message.
    if (
      isPausedSubagentRun(child) ||
      (await agents.approvals.holdsRun({ projectId, runId: child.id }))
    ) {
      throw new AgentToolPublicError(
        `[SixbAgentWorker] '${key}' is paused for the user's approval and reads no message until it continues, in the turn after the user decides. Message it then, or tell the user what to change.`
      )
    }
    const { status } = child
    if (status !== "queued" && status !== "running") {
      throw new AgentToolPublicError(
        `[SixbAgentWorker] '${key}' already ended (${status}), so it cannot read a message. Spawn a new child with another key to go on.`
      )
    }

    // While it waits on a question the model read, the message is its answer. The question is
    // claimed before any wait, so of two answers sent at once only the first is one.
    await this.#questions.refresh()
    const question = this.#questions.of(child.id)
    if (question && status === "running" && this.#reported.has(question.id)) {
      this.#questions.answered(question)
      try {
        await publishAgentMail(this.host.broker, {
          projectId,
          mail: {
            ...sent,
            fromRunId: this.parentRun.id,
            toThreadId: child.threadId,
            kind: "answer",
            inReplyTo: question.id,
            sentAt: new Date().toISOString(),
          },
        })
      } catch (error) {
        this.#questions.reopen(question)
        throw error
      }
      const output = { runId: child.id, status, delivery: "answer" } as const
      this.#answers.set(sent.id, output)
      return output
    }

    await publishAgentMail(this.host.broker, {
      projectId: this.context.id,
      mail: {
        ...sent,
        fromRunId: this.parentRun.id,
        toThreadId: child.threadId,
        kind: "message",
        sentAt: new Date().toISOString(),
      },
    })
    const toChild = this.#sent.get(child.id) ?? []
    if (!toChild.some((message) => message.id === sent.id)) toChild.push(sent)
    this.#sent.set(child.id, toChild)

    return { runId: child.id, status, delivery: status === "queued" ? "first-step" : "next-step" }
  }

  /** The latest child under `key` of this conversation's turns, this one's included. */
  private async latestChildUnder(key: string): Promise<SubagentRunRecord | undefined> {
    const [latest] = await this.context.storage.agents.runs.listThreadSubagents({
      projectId: this.context.id,
      threadId: this.parentRun.threadId,
      spawnKey: key,
      limit: 1,
    })
    return latest
  }

  /**
   * The child paused on its question that a message under `key` would continue: the latest run of
   * the latest thread under the key, or, past the continuations of it that failed or were stopped,
   * the run they continued, so their failure does not hide the question. A later spawn under the
   * key replaces it.
   */
  private async pausedOnQuestion(key: string): Promise<SubagentRunRecord | undefined> {
    const latest = await this.latestChildUnder(key)
    if (!latest) return undefined

    const runs = await listSubagentThreadRuns(this.context.storage.agents, {
      projectId: this.context.id,
      threadId: latest.threadId,
    })
    const live = [...runs]
      .reverse()
      .find((run) => run.status !== "failed" && run.status !== "cancelled")
    return live && isAwaitingAnswerRun(live) ? live : undefined
  }

  /** Whether a continuation went on with its parent's answer, as its trigger says. */
  private async continuesAfterAnswer(run: SubagentRunRecord): Promise<boolean> {
    const trigger = await this.context.storage.agents.messages.getById({
      projectId: this.context.id,
      id: run.triggerMessageId,
    })
    return trigger?.parts.some((part) => part.type === "mail" && part.kind === "answer") ?? false
  }

  private async subagentRun(id: string): Promise<SubagentRunRecord | undefined> {
    const run = await this.context.storage.agents.runs.getById({ projectId: this.context.id, id })
    return run?.kind === "subagent" ? run : undefined
  }

  /**
   * The children of this conversation still paused on their question, each with it: one indexed
   * read, which finds none in a conversation that has none, then one per key that has some.
   */
  async waitingQuestions(): Promise<readonly WaitedQuestion[]> {
    const paused = await this.context.storage.agents.runs.listThreadSubagents({
      projectId: this.context.id,
      threadId: this.parentRun.threadId,
      finishReason: "awaiting_answer",
    })
    const waiting: WaitedQuestion[] = []
    for (const key of new Set(paused.map((run) => run.spawnKey))) {
      const child = await this.pausedOnQuestion(key)
      const question = child ? await this.deferredQuestionOf(child) : undefined
      if (child && question) waiting.push({ key, runId: child.id, ...question })
    }
    return waiting
  }

  /**
   * Continue a child paused on its question, as a child of this turn under the same key, with this
   * message as the answer it reads first. Admissions go one at a time, so a second answer in the
   * same step finds the first one's continuation and is refused.
   */
  private async answerPaused(
    paused: SubagentRunRecord,
    key: string,
    sent: SentMessage,
    signal: AbortSignal
  ): Promise<MessageSubagentOutput> {
    const question = await this.deferredQuestionOf(paused)
    if (!question) {
      throw new Error(
        `[SixbAgentWorker] Subagent run '${paused.id}' paused on a question its thread does not hold.`
      )
    }
    const answer: AgentMailPart = {
      type: "mail",
      id: sent.id,
      from: "parent",
      kind: "answer",
      inReplyTo: question.id,
      text: sent.text,
    }
    const runId = createSubagentRunId(this.parentRun.id, key)
    const admitted = await this.admitInTurn(async () => {
      if (await this.subagentRun(runId)) {
        throw new AgentToolPublicError(
          `[SixbAgentWorker] '${key}' already continues with the answer you sent it this turn. Message it again once it is at work, or wait for it with wait_agent.`
        )
      }
      await this.clearDeadAttempts(paused, signal)
      const { spec, continuation } = this.continuationOf(paused, [answer])
      return this.admit(runId, key, spec, signal, {
        ...continuation,
        maxActiveChildren: this.context.subagentConcurrencyPerRun,
      })
    })

    const output: MessageSubagentOutput = {
      runId: admitted.runId,
      status: admitted.status === "queued" ? "queued" : "running",
      delivery: "answer",
      continues: paused.id,
    }
    this.#answers.set(sent.id, output)
    return output
  }

  /**
   * The question a child paused on, from its thread: the last message of the run that paused, its
   * work since its last delivery. Only one `awaiting_answer` has one.
   */
  private async deferredQuestionOf(run: SubagentRunRecord): Promise<QuestionRef | undefined> {
    if (!isAwaitingAnswerRun(run)) return undefined

    const { messages } = await this.context.storage.agents.messages.list({
      projectId: this.context.id,
      threadId: run.threadId,
      order: "desc",
      limit: 2,
    })
    const work = messages.find(
      (message) => message.runId === run.id && message.role === "assistant"
    )
    return work ? deferredChildQuestion([work]) : undefined
  }

  /**
   * The questions of the turn's children still at work that the model has not read, marked read:
   * its answer would otherwise end the turn without them.
   */
  async unreadQuestions(): Promise<readonly WaitedQuestion[]> {
    await this.#questions.refresh()
    const unread = (await this.askingChildren()).filter(
      (question) => !this.#reported.has(question.id)
    )
    for (const question of unread) this.#reported.add(question.id)
    return unread
  }

  /**
   * Before the turn records its end, while it still runs: tell each child still waiting on its
   * question that the turn ends without an answer, then wait, until `stopAt`, for each to pause on
   * it. The turn's end cancels the children still at work, so a child it told and that has not
   * paused yet would be stopped; while the turn runs, the repair pass leaves its children alone.
   */
  async deferOpenQuestions(stopAt: number, signal: AbortSignal): Promise<void> {
    let asking: readonly WaitedQuestion[]
    let threads: ReadonlyMap<string, string>
    try {
      await this.#questions.refresh()
      asking = await this.askingChildren()
      const runs = await this.context.storage.agents.runs.getByIds({
        projectId: this.context.id,
        ids: asking.map((question) => question.runId),
      })
      threads = new Map(
        runs.flatMap((run) => (run.kind === "subagent" ? [[run.id, run.threadId] as const] : []))
      )
    } catch (error) {
      console.error(
        `[SixbAgentWorker] Could not read the questions of Agent run '${this.parentRun.id}'; its children asking one are cancelled with the turn.`,
        error
      )
      return
    }

    const deferred: string[] = []
    for (const question of asking) {
      const threadId = threads.get(question.runId)
      if (threadId === undefined) continue
      try {
        await publishAgentMail(this.host.broker, {
          projectId: this.context.id,
          mail: {
            id: `${this.parentRun.id}:deferred:${question.id}`,
            fromRunId: this.parentRun.id,
            toThreadId: threadId,
            kind: "deferred",
            inReplyTo: question.id,
            text: "",
            sentAt: new Date().toISOString(),
          },
        })
        deferred.push(question.runId)
      } catch (error) {
        console.error(
          `[SixbAgentWorker] Could not tell subagent run '${question.runId}' that its question waits for a later turn; it is cancelled with the turn.`,
          error
        )
      }
    }

    try {
      while (deferred.length > 0 && Date.now() < stopAt) {
        const paused = this.#questions.nextChange()
        const runs = await this.context.storage.agents.runs.getByIds({
          projectId: this.context.id,
          ids: deferred,
        })
        if (runs.every((run) => run.status !== "queued" && run.status !== "running")) return
        await delay(Math.min(CHILD_WAIT_RECHECK_MS, stopAt - Date.now()), signal, paused)
      }
    } catch (error) {
      // The turn's interruption checks record why it stopped.
      if (signal.aborted) return
      throw error
    }
  }

  /**
   * Wait until none of the turn's children is queued or running, or `stopAt`: a pausing turn's
   * end cancels those still at work, and one that holds a call pauses by itself meanwhile.
   */
  async settleChildren(stopAt: number, signal: AbortSignal): Promise<void> {
    const { agents } = this.context.storage
    for (;;) {
      const finished = this.#questions.nextChange()
      if (!(await hasActiveChildren(agents, this.parentRun))) return

      const remainingMs = stopAt - Date.now()
      if (remainingMs <= 0) return
      try {
        await delay(Math.min(CHILD_WAIT_RECHECK_MS, remainingMs), signal, finished)
      } catch (error) {
        // The turn's interruption checks record why it stopped, with what it wrote.
        if (signal.aborted) return
        throw error
      }
    }
  }

  /** The open questions of the turn's children still at work, each with the child's key. */
  private async askingChildren(): Promise<readonly WaitedQuestion[]> {
    const open = this.#questions.open()
    if (open.length === 0) return []

    const runs = await this.context.storage.agents.runs.getByIds({
      projectId: this.context.id,
      ids: open.map((question) => question.runId),
    })
    const byId = new Map(runs.map((run) => [run.id, run]))
    return open.flatMap((question: ChildQuestion) => {
      const run = byId.get(question.runId)
      if (run?.kind !== "subagent" || run.parentRunId !== this.parentRun.id) return []
      if (run.status !== "running") return []

      return [{ key: run.spawnKey, runId: run.id, id: question.id, text: question.text }]
    })
  }

  async spawn(input: SpawnSubagentInput, signal: AbortSignal): Promise<SpawnSubagentOutput> {
    signal.throwIfAborted()
    const key = requireNonEmpty("spawn_agent", input.key, "key", 128)
    const task = requireNonEmpty("spawn_agent", input.task, "task")
    const model = this.resolveModel(input.model)
    const reasoning = input.reasoning ?? model.model.defaultReasoning
    const sources = input.files?.length
      ? await listHandedSources({ files: this.runFiles(), paths: input.files, signal })
      : undefined
    const runId = createSubagentRunId(this.parentRun.id, key)
    const specWith = (files: readonly SubagentRunFile[] | undefined) =>
      this.childSpec({ task, model, tier: model.tier, reasoning, files })

    // One admission at a time: only this turn adds children to it, so admission's answer is known
    // before any file is read, and a refused spawn reads and stores none.
    return this.admitInTurn(async () => {
      const existing = await this.admissionOf(runId, key)
      if (existing) {
        // The same child only if everything is the same, the files' bytes too.
        const files =
          sources && sameSpecBesidesFiles(existing.spec, specWith(undefined), sources)
            ? await handedFileRefs({ files: this.runFiles(), sources, signal })
            : undefined
        const spec = specWith(files)
        if (!isDeepStrictEqual(existing.spec, spec)) throw duplicateKey(key)
        return this.admit(runId, key, spec, signal)
      }

      const stored = sources
        ? await storeHandedFiles({ files: this.runFiles(), sources, signal })
        : undefined
      try {
        return await this.admit(runId, key, specWith(stored?.files), signal)
      } catch (error) {
        // Nothing was admitted, so the files do not count against the run.
        stored?.release()
        throw error
      }
    })
  }

  private admitInTurn<T>(admission: () => Promise<T>): Promise<T> {
    const admitted = this.#admissions.then(admission)
    this.#admissions = admitted.catch(() => {})
    return admitted
  }

  /**
   * What admission will answer, read before the files the child is handed: the child already
   * spawned with this key, else nothing once checked that the turn may spawn another.
   */
  private async admissionOf(runId: string, key: string): Promise<SubagentRunRecord | null> {
    const { runs } = this.context.storage.agents
    const maxActive = this.context.subagentConcurrencyPerRun
    const [existing, parent] = await Promise.all([
      runs.getById({ projectId: this.context.id, id: runId }),
      runs.getById({ projectId: this.context.id, id: this.parentRun.id }),
    ])
    if (existing) {
      // A continuation works in the thread of the turn that spawned it, never this turn's.
      if (
        existing.kind === "subagent" &&
        existing.threadId !== createSubagentThreadId(this.parentRun.id, key)
      ) {
        const after = (await this.continuesAfterAnswer(existing)) ? "your answer" : "the approval"
        throw new AgentToolPublicError(
          isTerminalSubagent(existing)
            ? `[SixbAgentWorker] '${key}' already continued after ${after}, and wait_agent returns how it ended. To run it again, spawn it with a new key.`
            : `[SixbAgentWorker] '${key}' is the sub-agent that continues after ${after}; wait for it with wait_agent.`
        )
      }
      if (existing.kind === "subagent" && existing.parentRunId === this.parentRun.id) {
        return existing
      }
      throw duplicateKey(key)
    }

    if (parent?.status !== "running") {
      throw publicSpawnError(
        new AgentStorageError("invalid_state", "Parent ended."),
        key,
        maxActive
      )
    }
    if (parent.execution?.token !== requiredExecutionToken(this.parentRun)) {
      throw new AgentStorageError(
        "execution_lost",
        `[SixbAgentWorker] Parent Agent run '${parent.id}' is no longer owned by this execution.`
      )
    }
    const active = await runs.list({
      projectId: this.context.id,
      kinds: ["subagent"],
      parentRunId: this.parentRun.id,
      statuses: ["queued", "running"],
      limit: 1,
    })
    if (active.total >= maxActive) {
      throw publicSpawnError(
        new AgentStorageError("active_child_limit", "Active child limit."),
        key,
        maxActive
      )
    }
    return null
  }

  /**
   * The run of this turn that continues `paused` in its thread: its model, task and files, this
   * turn's mode and deadline, and a trigger of what it goes on with (the outcomes of its calls, or
   * its parent's answer), what came back to its sandbox and when it continues.
   */
  private continuationOf(
    paused: SubagentRunRecord,
    goesOnWith: readonly AgentMessagePart[]
  ): {
    readonly spec: SubagentRunSpec
    readonly continuation: Pick<CreateSubagentRunInput, "thread" | "trigger" | "createdAt">
  } {
    const spec = this.childSpec({
      task: paused.spec.task,
      model: paused.spec.model,
      tier: paused.spec.tier,
      reasoning: paused.spec.reasoning,
      files: paused.spec.files,
    })
    const createdAt = new Date()
    const parts = continuationTrigger({
      goesOnWith,
      paused,
      createdAt,
      timeZone: spec.timeZone ?? this.context.timeZone,
    })
    return {
      spec,
      continuation: {
        thread: { id: paused.threadId, create: false },
        trigger: { id: createAgentMessageId(), parts },
        createdAt,
      },
    }
  }

  /** A child asks no less than its turn, dates as its requester does, and ends with the turn. */
  private childSpec(input: {
    readonly task: string
    readonly model: LanguageModelRef
    readonly tier: LanguageModelTier | undefined
    readonly reasoning: AgentReasoning | undefined
    readonly files: readonly SubagentRunFile[] | undefined
  }): SubagentRunSpec {
    const { task, model, tier, reasoning, files } = input
    const { approvalMode, timeZone, locale } = this.parentRun.spec ?? {}
    return {
      model: { provider: model.provider, modelId: model.modelId },
      task,
      toolNames: this.host.definitions.tools.list().map((definition) => definition.name),
      maxSteps: this.context.defaultMaxSteps,
      deadline: this.parentDeadline.toISOString(),
      ...(tier === undefined ? {} : { tier }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(approvalMode === undefined ? {} : { approvalMode }),
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(locale === undefined ? {} : { locale }),
      ...(files === undefined ? {} : { files }),
    }
  }

  /**
   * Admit a child of this turn. A spawned child works in a thread of its own, which starts with its
   * task and its files; a continuation goes into its thread with the outcomes it continues with.
   */
  private async admit(
    runId: string,
    key: string,
    spec: SubagentRunSpec,
    signal: AbortSignal,
    continuation?: Pick<CreateSubagentRunInput, "thread" | "trigger" | "createdAt"> & {
      readonly maxActiveChildren: number
    }
  ): Promise<SpawnSubagentOutput> {
    // Before it exists, so none of its questions is missed.
    await this.#questions.listen()
    const executionId = createSubagentExecutionId(runId)
    const execution = createInheritedAgentExecutionRecord({
      id: executionId,
      parent: this.parentExecution,
      runId,
    })

    let run: SubagentRunRecord
    try {
      run = await this.context.storage.transaction(async (storage) => {
        const agents = storage.agents
        if (!agents) {
          throw new Error("[SixbAgentWorker] Agent storage disappeared during child admission.")
        }
        await ensureExecutionRecord(storage.executions, execution)
        return agents.runs.createSubagent({
          id: runId,
          projectId: this.context.id,
          executionId,
          parentRunId: this.parentRun.id,
          parentExecutionToken: requiredExecutionToken(this.parentRun),
          spawnKey: key,
          spec,
          ...(continuation ?? {
            thread: { id: createSubagentThreadId(this.parentRun.id, key), create: true },
            trigger: {
              id: createAgentMessageId(),
              parts: [
                { type: "text", text: spec.task },
                ...(spec.files === undefined
                  ? []
                  : [{ type: "text" as const, text: renderHandedFiles(spec.files) }]),
              ],
            },
            maxActiveChildren: this.context.subagentConcurrencyPerRun,
          }),
        })
      })
    } catch (error) {
      throw publicSpawnError(error, key, this.context.subagentConcurrencyPerRun)
    }

    signal.throwIfAborted()
    if (run.status === "queued") {
      const dispatched = await dispatchQueuedSubagentRuns({
        projectId: this.context.id,
        storage: this.context.storage.agents,
        queue: this.host.queues.agentChildren,
        runIds: [run.id],
      })
      if (dispatched.failures.length > 0) {
        console.error(
          `[SixbAgentWorker] Could not dispatch subagent run '${run.id}'; reconciliation will retry.`,
          dispatched.failures[0]?.error
        )
      }
    }

    return {
      runId: run.id,
      status: run.status,
      model: { provider: run.spec.model.provider, modelId: run.spec.model.modelId },
    }
  }

  async wait(input: WaitForSubagentsInput, signal: AbortSignal): Promise<WaitForSubagentsOutput> {
    const passedIds = normalizeRunIds(input.runIds, this.context.subagentConcurrencyPerRun)
    // A child of an earlier turn is waited for as the child of this one that continues it, else
    // as it ended.
    const runIds = await Promise.all(passedIds.map((runId) => this.continuedChildId(runId)))
    const earlierTurns = await this.earlierTurnsOf(runIds)
    // The Agent answers before its turn times out, with or without the children still at work.
    const stopAt = this.parentDeadline.getTime() - WAIT_ANSWER_MARGIN_MS
    for (;;) {
      signal.throwIfAborted()
      // Taken before the reads, so a question or a finish that comes during them wakes the wait.
      const changed = this.#questions.nextChange()
      const runs = await this.context.storage.agents.runs.getByIds({
        projectId: this.context.id,
        ids: runIds,
      })
      const byId = new Map(runs.map((run) => [run.id, run]))
      const children = runIds.map((runId, index) => {
        const run = byId.get(runId)
        if (
          !run ||
          run.kind !== "subagent" ||
          (run.parentRunId !== this.parentRun.id && !earlierTurns.has(run.parentRunId))
        ) {
          throw new AgentToolPublicError(
            `[SixbAgentWorker] '${passedIds[index]}' is not a child of the current Agent run.`
          )
        }
        return run
      })
      // A child blocked on its question waits for this turn, so a new question ends any wait,
      // and one already returned ends a wait for its own child. Without the wake, it reads them.
      if (!this.#questions.listening) await this.#questions.refresh()
      const asking = await this.askingChildren()
      const asked = asking.some(
        (question) => !this.#reported.has(question.id) || runIds.includes(question.runId)
      )
      const remainingMs = stopAt - Date.now()
      if (children.every(isTerminalSubagent) || asked || remainingMs <= 0) {
        const awaiting = await listChildApprovalsAwaiting(this.context.storage.agents, {
          projectId: this.context.id,
          parentRunId: this.parentRun.id,
          childRunIds: runIds,
        })
        const delivered = await this.deliverFiles(children, signal)
        const messages = await Promise.all(children.map((run) => this.messagesTo(run)))
        // It lists the questions it returns first, and those its children wait on.
        const listed = asking.filter(
          (question) => !this.#reported.has(question.id) || runIds.includes(question.runId)
        )
        for (const question of asking) this.#reported.add(question.id)
        const open = new Map(asking.map((question) => [question.runId, question]))
        const questions = await Promise.all(
          children.map(async (run) => open.get(run.id) ?? (await this.deferredQuestionOf(run)))
        )
        return {
          // Each result keeps the id the Agent passed.
          results: children.map((run, index) => ({
            ...waitedResult(
              run,
              awaiting.get(run.id),
              delivered.byChild.get(run.id),
              questions[index]
            ),
            ...messages[index],
            runId: passedIds[index] ?? run.id,
          })),
          ...(listed.length > 0 ? { questions: listed } : {}),
          files: delivered.attached,
          ...(delivered.artifactsError === undefined
            ? {}
            : { artifactsError: delivered.artifactsError }),
        }
      }
      // A child of an earlier turn finishes into that turn's inbox, which this one does not hear.
      const unheard = children.some(
        (run) => run.parentRunId !== this.parentRun.id && !isTerminalSubagent(run)
      )
      const recheckMs = unheard ? OTHER_INBOX_RECHECK_MS : CHILD_WAIT_RECHECK_MS
      await delay(Math.min(recheckMs, remainingMs), signal, changed)
    }
  }

  /**
   * What became of what this turn sent an ended child, from its thread, which holds each message
   * it read: those it did not read, and, when one came as it answered, the answer it gave before.
   * A failed child's failure is what the parent acts on.
   */
  private async messagesTo(run: SubagentRunRecord): Promise<MessagesReport> {
    const sent = this.#sent.get(run.id)
    if (!sent || !isTerminalSubagent(run) || run.status === "failed") return {}

    const { messages } = await this.context.storage.agents.messages.list({
      projectId: this.context.id,
      threadId: run.threadId,
      order: "asc",
    })
    const read = new Set(
      messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "mail" ? [part.id] : []))
      )
    )
    const unread = sent.filter((message) => !read.has(message.id))
    return {
      ...(unread.length > 0 ? { unread } : {}),
      ...answerBeforeLateMessage(
        messages.filter((message) => message.runId === run.id),
        run.result?.text ?? ""
      ),
    }
  }

  /**
   * The run a child of an earlier turn is waited for as: its thread's latest, the one that continues
   * it when this turn resumes its pause; else `runId` itself.
   */
  private async continuedChildId(runId: string): Promise<string> {
    const { runs } = this.context.storage.agents
    const projectId = this.context.id
    const waited = await runs.getById({ projectId, id: runId })
    if (waited?.kind !== "subagent" || waited.parentRunId === this.parentRun.id) return runId

    const latest = await listSubagentThreadRuns(this.context.storage.agents, {
      projectId,
      threadId: waited.threadId,
    })
    return latest.at(-1)?.id ?? runId
  }

  /** Which parents of these children are earlier turns of this turn's conversation. */
  private async earlierTurnsOf(runIds: readonly string[]): Promise<ReadonlySet<string>> {
    const { runs } = this.context.storage.agents
    const projectId = this.context.id
    const children = await runs.getByIds({ projectId, ids: runIds })
    const parentIds = children.flatMap((run) =>
      run.kind === "subagent" && run.parentRunId !== this.parentRun.id ? [run.parentRunId] : []
    )
    if (parentIds.length === 0) return new Set()

    const parents = await runs.getByIds({ projectId, ids: parentIds })
    return new Set(
      parents
        .filter(
          (parent) =>
            parent.kind === "conversation" &&
            parent.threadId === this.parentRun.threadId &&
            parent.createdAt <= this.parentRun.createdAt
        )
        .map((parent) => parent.id)
    )
  }

  /**
   * Copy what each finished child wrote under `out/` into the parent's sandbox, once, and install
   * what the children published in its `$SIXB_ARTIFACTS`, as the parent's own. A result holds at
   * most the attachment limits of new files, a child's whole or not at all; a child that does not
   * fit, or whose files cannot be copied, says so, and its files come with a later wait.
   */
  private async deliverFiles(
    children: readonly SubagentRunRecord[],
    signal: AbortSignal
  ): Promise<{
    readonly byChild: ReadonlyMap<string, ChildFiles>
    readonly attached: readonly InstalledChildFile[]
    readonly artifactsError?: string
  }> {
    const byChild = new Map<string, ChildFiles>()
    const attached: InstalledChildFile[] = []
    let attachedBytes = 0

    for (const child of children) {
      if (child.status !== "succeeded") continue
      if (isAwaitingAnswerRun(child)) {
        if (child.result?.files?.length) {
          byChild.set(child.id, { note: "They come back once it continues and finishes." })
        }
        continue
      }
      if (isPausedSubagentRun(child)) {
        if (child.result?.files?.length) {
          byChild.set(child.id, {
            note: "They come back if it continues once the user decides, when it finishes.",
          })
        }
        continue
      }
      const { files: outputs = [], filesError } = child.result ?? {}
      if (filesError) byChild.set(child.id, { note: filesError })

      const installed = this.#installed.get(child.id)
      if (installed) {
        byChild.set(child.id, { files: installed })
        continue
      }
      if (outputs.length === 0) continue

      const bytes = outputs.reduce((sum, file) => sum + file.fileRef.sizeBytes, 0)
      const { maxFiles, totalMaxBytes } = SANDBOX_ATTACHMENT_LIMITS
      const fits =
        attached.length + outputs.length <= maxFiles && attachedBytes + bytes <= totalMaxBytes
      if (!fits && attached.length > 0) {
        byChild.set(child.id, {
          note: `Its ${outputs.length} files did not fit in this result, which holds at most ${maxFiles} files, ${formatBytes(totalMaxBytes)} in all. Wait for this child again to get them.`,
        })
        continue
      }

      try {
        const copied = await installChildOutputs({
          files: this.runFiles(),
          key: child.spawnKey,
          outputs,
          signal,
        })
        this.#installed.set(child.id, copied)
        attached.push(...copied)
        attachedBytes += bytes
        byChild.set(child.id, { files: copied })
      } catch (error) {
        if (signal.aborted) throw error
        byChild.set(child.id, {
          note: `Its files could not be copied into your sandbox (${errorMessage(error)}). Wait for this child again to retry.`,
        })
      }
    }

    let artifactsError: string | undefined
    try {
      await this.#runFiles?.installArtifactsFrom(
        children.map((child) => child.id),
        signal
      )
    } catch (error) {
      if (signal.aborted) throw error
      artifactsError = `What these children published could not all be installed in $SIXB_ARTIFACTS (${errorMessage(error)}). The addresses in their answers still work.`
    }
    return { byChild, attached, ...(artifactsError === undefined ? {} : { artifactsError }) }
  }

  private runFiles(): AgentRunFiles {
    if (!this.#runFiles) {
      throw new Error("[SixbAgentWorker] Delegation tools ran before their run's environment.")
    }
    return this.#runFiles
  }

  private resolveModel(ref: LanguageModelRef | LanguageModelTier | undefined) {
    if (ref === undefined) return this.models.default
    if (typeof ref === "string") return this.models.getByTier(ref)
    const model = this.models.getByRef(ref)
    if (model) return model
    const available = this.models.list().map(formatModelRef).join(", ")
    throw new AgentToolPublicError(
      `[SixbAgentWorker] Language model ${formatModelRef(ref)} is not configured for this project. ` +
        `Use one of: ${available}. Omit model to use the project default.`
    )
  }
}

/**
 * Built from each model's configured definition, never from its provider catalog: the guide is in
 * every turn's tools, so it stays the same for the process and catalog I/O cannot fail a turn.
 */
export function renderSubagentModelGuide(models: LanguageModelCatalog): string {
  const entries = models.list().map((entry) => {
    const metadata = defineLanguageModel(entry.model.definition)
    if (metadata.providerId !== entry.provider || metadata.modelId !== entry.modelId) {
      throw new Error(
        "[SixbAgentWorker] Delegation model definition identity does not match its catalog entry."
      )
    }
    const details: string[] = []
    if (sameModel(entry, models.default)) details.push("default")
    if (metadata.contextWindow !== undefined)
      details.push(`context ${formatTokenCount(metadata.contextWindow)} tokens`)
    if (metadata.maxInputTokens !== undefined)
      details.push(`max input ${formatTokenCount(metadata.maxInputTokens)} tokens`)
    if (metadata.capabilities.reasoning) details.push("reasoning")
    if (metadata.capabilities.localTools) details.push("tools")
    const media = metadata.capabilities.inputMediaTypes
    if (media === "any") details.push("multimodal input")
    else if (media?.length) details.push(`input: ${media.join(", ")}`)
    if (details.length === 0 || (details.length === 1 && details[0] === "default"))
      details.push("metadata unavailable")

    return renderModelLine({
      ...(entry.tier === undefined ? {} : { tier: entry.tier }),
      reference: formatModelRef(entry),
      ...(metadata.name === undefined ? {} : { name: metadata.name }),
      details: `(${details.join("; ")})`,
      ...(metadata.description === undefined ? {} : { description: metadata.description }),
    })
  })

  const { tiers } = models
  if (tiers.length === 0) {
    return ["Available models (provider-declared metadata when available):", ...entries].join("\n")
  }

  return [
    "Models you can delegate to:",
    ...entries,
    "Tiers rank cost and strength: light is the cheapest and fastest, heavy the strongest.",
    `Use a tier by default (model: ${tiers.map((tier) => `"${tier}"`).join(" | ")}). Use a specific model when its description fits the task.`,
  ].join("\n")
}

function modelChoice(models: LanguageModelCatalog): typeof LISTED_MODEL_CHOICE {
  return models.tiers.length > 0 ? TIERED_MODEL_CHOICE : LISTED_MODEL_CHOICE
}

function formatModelRef({ provider, modelId }: LanguageModelRef): string {
  return JSON.stringify({ provider, modelId })
}

function sameModel(
  left: { readonly provider: string; readonly modelId: string },
  right: { readonly provider: string; readonly modelId: string }
): boolean {
  return left.provider === right.provider && left.modelId === right.modelId
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${formatScaled(value, 1_000_000)}M`
  if (value >= 1_000) return `${formatScaled(value, 1_000)}k`
  return String(value)
}

function formatScaled(value: number, scale: number): string {
  return (Math.round((value / scale) * 100) / 100).toString()
}

function spawnInputSchema(models: LanguageModelCatalog): JsonObject {
  return {
    type: "object",
    properties: {
      key: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "Stable key for this logical delegation, for example 'compare-suppliers'.",
      },
      task: { type: "string", minLength: 1, description: "Focused task for the child agent." },
      model: {
        description: `${modelChoice(models).field} Keep provider and modelId unchanged, including any '/' inside modelId. ${OMIT_MODEL}`,
        anyOf: [...tierChoice(models.tiers), ...modelRefChoices(models)],
      },
      reasoning: {
        anyOf: [
          { type: "string", enum: [...AGENT_REASONING_LEVELS] },
          {
            type: "object",
            properties: { budgetTokens: { type: "integer", minimum: 0 } },
            required: ["budgetTokens"],
            additionalProperties: false,
          },
        ],
      },
      files: {
        type: "array",
        minItems: 1,
        maxItems: SANDBOX_ATTACHMENT_LIMITS.maxFiles,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
        description:
          "Paths of files or directories in your sandbox, such as an attachment from $SIXB_ATTACHMENTS or out/chart.png.",
      },
    },
    required: ["key", "task"],
    additionalProperties: false,
  }
}

function tierChoice(tiers: readonly LanguageModelTier[]): readonly JsonObject[] {
  return tiers.length > 0 ? [{ type: "string", enum: [...tiers] }] : []
}

// Keep each pair together: independent enums would also admit unconfigured bindings.
function modelRefChoices(models: LanguageModelCatalog): readonly JsonObject[] {
  return models.list().map(({ provider, modelId }) => ({
    type: "object",
    properties: {
      provider: { type: "string", enum: [provider] },
      modelId: { type: "string", enum: [modelId] },
    },
    required: ["provider", "modelId"],
    additionalProperties: false,
  }))
}

function messageInputSchema(): JsonObject {
  return {
    type: "object",
    properties: {
      key: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description: "The key you spawned the child with.",
      },
      text: {
        type: "string",
        minLength: 1,
        description: "What the child should change or know, as an instruction for its task.",
      },
    },
    required: ["key", "text"],
    additionalProperties: false,
  }
}

function waitInputSchema(maxRunIds: number): JsonObject {
  return {
    type: "object",
    properties: {
      runIds: {
        type: "array",
        minItems: 1,
        maxItems: maxRunIds,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    },
    required: ["runIds"],
    additionalProperties: false,
  }
}

function normalizeRunIds(value: readonly string[], maxRunIds: number): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxRunIds) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] wait_agent requires between 1 and ${maxRunIds} child run ids.`
    )
  }
  const runIds = value.map((runId) => requireNonEmpty("wait_agent", runId, "runId"))
  if (new Set(runIds).size !== runIds.length) {
    throw new AgentToolPublicError("[SixbAgentWorker] wait_agent run ids must be unique.")
  }
  return runIds
}

function requireNonEmpty(
  toolName: "spawn_agent" | "wait_agent" | "message_agent",
  value: unknown,
  field: string,
  maxLength?: number
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AgentToolPublicError(`[SixbAgentWorker] ${toolName} ${field} must not be empty.`)
  }
  const normalized = value.trim()
  if (maxLength !== undefined && normalized.length > maxLength) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] ${toolName} ${field} must not exceed ${maxLength} characters.`
    )
  }
  return normalized
}

function requiredExecutionToken(run: ConversationAgentRunRecord): string {
  if (!run.execution?.token) {
    throw new Error(`[SixbAgentWorker] Parent Agent run '${run.id}' has no execution token.`)
  }
  return run.execution.token
}

function publicSpawnError(error: unknown, key: string, maxActive: number): unknown {
  if (!(error instanceof AgentStorageError)) return error
  switch (error.code) {
    case "active_child_limit":
      return new AgentToolPublicError(
        `[SixbAgentWorker] The current Agent run already has ${maxActive} active children. Wait for one before spawning another.`
      )
    case "duplicate_id":
      return new AgentToolPublicError(
        `[SixbAgentWorker] spawn_agent key '${key}' was already used with different inputs.`
      )
    case "invalid_state":
      return new AgentToolPublicError("[SixbAgentWorker] The parent Agent run is no longer active.")
    default:
      return error
  }
}

/**
 * When a message came as the child answered (`afterAnswer`), the answer it gave before: kept for
 * the parent beside the one it wrote after, which may only amend it. If it wrote none after, its
 * answer is the one before, and the parent is told it predates the message.
 */
function answerBeforeLateMessage(
  transcript: readonly AgentMessage[],
  answer: string
): Pick<WaitedSubagentResult, "earlierAnswer" | "answerNote"> {
  const isLate = (message: AgentMessage) =>
    message.parts.some((part) => part.type === "mail" && part.afterAnswer === true)
  const late = transcript.map(isLate).lastIndexOf(true)
  const before = late > 0 ? transcript[late - 1] : undefined
  if (before?.role !== "assistant") return {}

  const earlier = answerOfSteps(before.parts)
  if (!earlier) return {}
  return earlier === answer
    ? {
        answerNote:
          "It wrote this answer before your last message came, and did not answer again after reading it.",
      }
    : { earlierAnswer: earlier }
}

/** The text written after the last local tool call of these steps, as a child's answer is. */
function answerOfSteps(parts: readonly AgentMessagePart[]): string {
  const steps: AgentMessagePart[][] = []
  for (const part of parts) {
    if (part.type === "step-start" || steps.length === 0) steps.push([])
    if (part.type !== "step-start") steps.at(-1)?.push(part)
  }
  const ranTools = steps.map((step) =>
    step.some((part) => part.type === "tool-call" && part.providerExecuted !== true)
  )
  return steps
    .slice(ranTools.lastIndexOf(true) + 1)
    .flat()
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
}

function isTerminalSubagent(
  run: SubagentRunRecord
): run is SubagentRunRecord & { readonly status: "succeeded" | "failed" | "cancelled" } {
  return run.status !== "queued" && run.status !== "running"
}

interface ChildFiles {
  readonly files?: readonly InstalledChildFile[]
  readonly note?: string
}

function waitedResult(
  run: SubagentRunRecord,
  awaitingApproval: readonly AgentChildApprovalAwaiting[] | undefined,
  files: ChildFiles | undefined,
  question: QuestionRef | undefined
): WaitedSubagentResult {
  return {
    runId: run.id,
    status: isPausedSubagentRun(run)
      ? "awaiting_approval"
      : isAwaitingAnswerRun(run)
        ? "awaiting_answer"
        : run.status,
    ...(run.result?.text ? { text: run.result.text } : {}),
    ...(question === undefined ? {} : { question: { id: question.id, text: question.text } }),
    ...(run.error === undefined
      ? {}
      : { error: { code: run.error.code, message: run.error.message } }),
    ...(awaitingApproval?.length ? { awaitingApproval } : {}),
    ...(files?.files?.length
      ? {
          files: files.files.map(({ path, sandboxPath, fileRef }) => ({
            path,
            sandboxPath,
            sizeBytes: fileRef.sizeBytes,
            ...(fileRef.mediaType === undefined ? {} : { mediaType: fileRef.mediaType }),
          })),
        }
      : {}),
    ...(files?.note === undefined ? {} : { filesNote: files.note }),
  }
}

/** Whether a spawn under a key in use may be its replay, before reading its files' bytes. */
function sameSpecBesidesFiles(
  existing: SubagentRunSpec,
  spec: SubagentRunSpec,
  sources: readonly { readonly path: string; readonly sizeBytes?: number }[]
): boolean {
  const { files: existingFiles = [], ...existingRest } = existing
  const { files: _files, ...rest } = spec
  return (
    isDeepStrictEqual(existingRest, rest) &&
    existingFiles.length === sources.length &&
    existingFiles.every(
      (file, index) =>
        file.path === sources[index]?.path &&
        (sources[index]?.sizeBytes ?? file.fileRef.sizeBytes) === file.fileRef.sizeBytes
    )
  )
}

function duplicateKey(key: string): AgentToolPublicError {
  return new AgentToolPublicError(
    `[SixbAgentWorker] spawn_agent key '${key}' was already used with different inputs.`
  )
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\[\w+\] /, "")
}

function parseSpawnInput(value: unknown): SpawnSubagentInput {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !["key", "task", "model", "reasoning", "files"].includes(key))
  ) {
    throw new AgentToolPublicError(
      "[SixbAgentWorker] spawn_agent expects key, task, and optional model/reasoning/files."
    )
  }
  const key = requireNonEmpty("spawn_agent", value.key, "key", 128)
  const task = requireNonEmpty("spawn_agent", value.task, "task")
  let model: LanguageModelRef | LanguageModelTier | undefined
  if (typeof value.model === "string") {
    if (!isLanguageModelTier(value.model)) {
      throw new AgentToolPublicError(
        `[SixbAgentWorker] Unknown spawn_agent model tier '${value.model}'. Use ${formatLanguageModelTiers()}, or a model reference.`
      )
    }
    model = value.model
  } else if (value.model !== undefined) {
    if (
      !isJsonObject(value.model) ||
      Object.keys(value.model).some((key) => !["provider", "modelId"].includes(key))
    ) {
      throw new AgentToolPublicError(
        "[SixbAgentWorker] spawn_agent model requires provider and modelId."
      )
    }
    model = {
      provider: requireNonEmpty("spawn_agent", value.model.provider, "model.provider"),
      modelId: requireNonEmpty("spawn_agent", value.model.modelId, "model.modelId"),
    }
  }
  if (value.reasoning !== undefined && !isModelReasoning(value.reasoning)) {
    throw new AgentToolPublicError("[SixbAgentWorker] spawn_agent reasoning is invalid.")
  }
  const files = parseSpawnFiles(value.files)
  return {
    key,
    task,
    ...(model === undefined ? {} : { model }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
    ...(files === undefined ? {} : { files }),
  }
}

function parseSpawnFiles(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined

  const { maxFiles } = SANDBOX_ATTACHMENT_LIMITS
  if (!Array.isArray(value) || value.length > maxFiles) {
    throw new AgentToolPublicError(
      `[SixbAgentWorker] spawn_agent files must be a list of at most ${maxFiles} sandbox paths.`
    )
  }
  const files = value.map((path) => requireNonEmpty("spawn_agent", path, "files entry"))
  if (new Set(files).size !== files.length) {
    throw new AgentToolPublicError("[SixbAgentWorker] spawn_agent files must not repeat a path.")
  }
  return files.length > 0 ? files : undefined
}

function parseMessageInput(value: unknown): MessageSubagentInput {
  if (!isJsonObject(value) || Object.keys(value).some((key) => key !== "key" && key !== "text")) {
    throw new AgentToolPublicError("[SixbAgentWorker] message_agent expects key and text.")
  }
  return {
    key: requireNonEmpty("message_agent", value.key, "key", 128),
    text: requireNonEmpty("message_agent", value.text, "text"),
  }
}

function parseWaitInput(value: unknown, maxRunIds: number): WaitForSubagentsInput {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => key !== "runIds") ||
    !Array.isArray(value.runIds) ||
    !value.runIds.every((id) => typeof id === "string")
  ) {
    throw new AgentToolPublicError(
      "[SixbAgentWorker] wait_agent expects an array of child run ids."
    )
  }
  return { runIds: normalizeRunIds(value.runIds, maxRunIds) }
}
