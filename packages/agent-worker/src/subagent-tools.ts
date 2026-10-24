import { isDeepStrictEqual } from "node:util"
import {
  AGENT_REASONING_LEVELS,
  type AgentApprovalOutcomePart,
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
  dispatchQueuedSubagentRuns,
  isAgentToolResult,
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
import { agentToolErrorText } from "./model-adapters"
import { renderModelLine } from "./model-lines"
import { continuationTrigger, isPausedSubagent } from "./subagent-continuation"
import type { AgentRunFiles, AgentWorkerContext, AgentWorkerHost } from "./types"

/** How often a wait for children reads their runs. */
export const WAIT_POLL_MS = 250
/**
 * How long before its turn's deadline `wait_agent` stops waiting, so the Agent still answers with
 * what its children found. A last step without tools takes seconds on a light model and up to about
 * a minute on a heavy one with high reasoning; a turn has ten minutes by default.
 */
export const WAIT_ANSWER_MARGIN_MS = 60_000

const OMIT_MODEL = "Omit model to use the project default."

/** How many of a conversation's latest turns a refused `message_agent` looks through for its key. */
const EARLIER_TURNS_SEARCHED = 20

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
  /** When the child reads it: before its first step while it is queued, else before its next. */
  readonly delivery: "first-step" | "next-step"
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
   * `awaiting_approval`: it paused on calls that wait for the user, and continues once they decide.
   */
  readonly status: SubagentRunRecord["status"] | "awaiting_approval"
  readonly text?: string
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

export interface WaitForSubagentsOutput {
  readonly results: readonly WaitedSubagentResult[]
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
      const runId = createSubagentRunId(this.parentRun.id, child.spawnKey)
      await this.clearDeadAttempts(child, signal)

      const spec = this.childSpec({
        task: child.spec.task,
        model: child.spec.model,
        reasoning: child.spec.reasoning,
        files: child.spec.files,
      })
      const createdAt = new Date()
      const parts = continuationTrigger({
        outcomes,
        paused: child,
        createdAt,
        timeZone: spec.timeZone ?? this.context.timeZone,
      })
      await this.admitInTurn(() =>
        this.admit(runId, child.spawnKey, spec, signal, {
          thread: { id: child.threadId, create: false },
          trigger: { id: createAgentMessageId(), parts },
          createdAt,
          // Each was admitted within the limit; the turn starts with all of them at once.
          maxActiveChildren: Math.max(this.context.subagentConcurrencyPerRun, paused.length),
        })
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
      await delay(Math.min(WAIT_POLL_MS, remainingMs), signal)
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
      if (child.kind !== "subagent" || !isPausedSubagent(child)) continue

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
        "A child paused on calls that wait for the user's approval returns as awaiting_approval, with those calls: it continues once the user decides.",
        "A message you sent a child that it has not read is listed in its unread. When one came as it answered, earlierAnswer holds what it answered before, and text what it wrote after.",
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
    const { agents } = this.context.storage
    const projectId = this.context.id
    const child = await agents.runs.getById({
      projectId,
      id: createSubagentRunId(this.parentRun.id, key),
    })
    if (child?.kind !== "subagent" || child.parentRunId !== this.parentRun.id) {
      throw new AgentToolPublicError(
        (await this.spawnedInEarlierTurn(key))
          ? `[SixbAgentWorker] '${key}' is a child agent of an earlier turn, which ended with it. Spawn it again in this turn, with the same key if you like, and message it then.`
          : `[SixbAgentWorker] '${key}' is not a child agent of this turn. Use the key you passed to spawn_agent.`
      )
    }
    // Once its call is filed it pauses at the end of its step, before it would read a message.
    if (
      isPausedSubagent(child) ||
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

    const sent = { id: `${this.parentRun.id}:${callId}`, text }
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

  /** Whether an earlier turn of this conversation, among its latest, spawned a child with `key`. */
  private async spawnedInEarlierTurn(key: string): Promise<boolean> {
    const { runs } = this.context.storage.agents
    const projectId = this.context.id
    const { runs: turns } = await runs.list({
      projectId,
      kinds: ["conversation"],
      threadId: this.parentRun.threadId,
      order: "desc",
      limit: EARLIER_TURNS_SEARCHED,
    })
    const ids = turns
      .filter((turn) => turn.id !== this.parentRun.id)
      .map((turn) => createSubagentRunId(turn.id, key))
    return ids.length > 0 && (await runs.getByIds({ projectId, ids })).length > 0
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
      this.childSpec({ task, model, reasoning, files })

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
        throw new AgentToolPublicError(
          isTerminalSubagent(existing)
            ? `[SixbAgentWorker] '${key}' already continued after the approval, and wait_agent returns how it ended. To run it again, spawn it with a new key.`
            : `[SixbAgentWorker] '${key}' is the sub-agent that continues after the approval; wait for it with wait_agent.`
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

  /** A child asks no less than its turn, dates as its requester does, and ends with the turn. */
  private childSpec(input: {
    readonly task: string
    readonly model: LanguageModelRef
    readonly reasoning: AgentReasoning | undefined
    readonly files: readonly SubagentRunFile[] | undefined
  }): SubagentRunSpec {
    const { task, model, reasoning, files } = input
    const { approvalMode, timeZone, locale } = this.parentRun.spec ?? {}
    return {
      model: { provider: model.provider, modelId: model.modelId },
      task,
      toolNames: this.host.definitions.tools.list().map((definition) => definition.name),
      maxSteps: this.context.defaultMaxSteps,
      deadline: this.parentDeadline.toISOString(),
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
      const remainingMs = stopAt - Date.now()
      if (children.every(isTerminalSubagent) || remainingMs <= 0) {
        const awaiting = await listChildApprovalsAwaiting(this.context.storage.agents, {
          projectId: this.context.id,
          parentRunId: this.parentRun.id,
          childRunIds: runIds,
        })
        const delivered = await this.deliverFiles(children, signal)
        const messages = await Promise.all(children.map((run) => this.messagesTo(run)))
        return {
          // Each result keeps the id the Agent passed.
          results: children.map((run, index) => ({
            ...waitedResult(run, awaiting.get(run.id), delivered.byChild.get(run.id)),
            ...messages[index],
            runId: passedIds[index] ?? run.id,
          })),
          files: delivered.attached,
          ...(delivered.artifactsError === undefined
            ? {}
            : { artifactsError: delivered.artifactsError }),
        }
      }
      await delay(Math.min(WAIT_POLL_MS, remainingMs), signal)
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
      if (isPausedSubagent(child)) {
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
  files: ChildFiles | undefined
): WaitedSubagentResult {
  return {
    runId: run.id,
    status: isPausedSubagent(run) ? "awaiting_approval" : run.status,
    ...(run.result?.text ? { text: run.result.text } : {}),
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
