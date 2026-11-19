import { randomUUID } from "node:crypto"
import { announceArtifactUpdates } from "../artifacts/events"
import { undoneTurnDocuments } from "../artifacts/publish/merge"
import type { Principal } from "../auth"
import { principalsEqual, SYSTEM_PRINCIPAL } from "../auth"
import { assertAuthorized } from "../authorization"
import type { FileRef } from "../blob-storage"
import type { BlobStorage } from "../blob-storage/types"
import { isValidFileRef } from "../blob-storage/validation"
import { canonicalTimeZone } from "../calendar"
import {
  canInheritAgentRequestAuthorization,
  createInheritedAgentExecutionRecord,
} from "../execution/agent"
import { resolveExecutionScopeAuthorization } from "../execution/authorization"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import type { ExecutionContext } from "../execution/types"
import type {
  LanguageModelCatalog,
  LanguageModelEntry,
  LanguageModelRef,
  LanguageModelTierProbabilities,
} from "../models"
import { isModelReasoning, modelReasoningSupportIssue } from "../models/language-model"
import { resolveLanguageModel } from "../models/resolve"
import { canonicalLocale } from "../runtime/locale"
import type { SixbRuntimeContext } from "../runtime/types"
import {
  type AgentApprovalMode,
  type AgentApprovalRecord,
  type AgentInboxItemRecord,
  type AgentMessageRecord,
  type AgentStorage,
  AgentStorageError,
  type AgentThreadComputer,
  type AgentThreadRecord,
  type ConversationAgentRunRecord,
  type ConversationAgentRunSpec,
} from "../storage/agents"
import { type AgentTurnPlace, countsAsThreadMessage, turnPlace } from "../storage/agents/provider"
import {
  aiLimitSubjectsFromAttribution,
  aiUsageLimitExceededError,
  aiUsageLimitUnavailableError,
  applicableAiLimitPolicyStatuses,
} from "../storage/ai-limits/enforcement"
import type { AiLimitPolicyStatus } from "../storage/ai-limits/types"
import type { PublishedArtifactVersion } from "../storage/artifacts/types"
import type { ExecutionRecord } from "../storage/executions"
import type { Storage } from "../storage/types"
import {
  type AgentTurnReadiness,
  announceAgentApprovals,
  assertAgentApprovalMode,
  isAwaitingApprovalRun,
  listTurnApprovals,
  reportAgentApprovals,
  reportSettledAgentApprovals,
  resolveAgentApprovalMode,
  turnResumeReadiness,
} from "./approvals"
import { cancelAgentRun } from "./cancel"
import type { AgentContextEntryInput } from "./context/entries"
import { resolveAgentContextParts } from "./context-resolution"
import { dispatchQueuedAgentRuns } from "./dispatch"
import { AgentRequestError } from "./errors"
import {
  createAgentInboxItemId,
  createAgentMessageId,
  createAgentRunId,
  createAgentThreadId,
} from "./ids"
import type { AgentMessagePart } from "./message"
import type { TurnModelRouter } from "./model-routing"
import { assertNoAgentSelector } from "./retired-config"
import { publishAgentRunActivity } from "./streams/protocol"
import { assertConversationThread } from "./thread-access"
import { turnAnsweredEveryMessage } from "./turn-answered"
import { AGENT_REASONING_LEVELS, type AgentReasoning } from "./types"

export interface RequestAgentRunInput {
  /**
   * The user's message that triggers the turn. Omitted to {@link continue}, or when
   * {@link attachments} are the whole message.
   */
  readonly text?: string
  /**
   * Continue an answer the turn limit cut short, in an existing thread. Sixb writes the
   * instruction the model reads, so the request carries no text, attachments, or context.
   */
  readonly continue?: boolean
  /** Blob-backed files attached to the trigger message. */
  readonly attachments?: readonly FileRef[]
  /** Structured page/object context snapshotted onto the triggering user message. */
  readonly context?: readonly AgentContextEntryInput[]
  /** Continue an existing thread. Omitted → a fresh thread is created for this agent. */
  readonly threadId?: string
  /** Configured language model selected for this turn. Omitted uses the agent default. */
  readonly model?: LanguageModelRef
  /** Reasoning effort or token budget for this turn. Omitted uses the model's default. */
  readonly reasoning?: AgentReasoning
  /**
   * IANA time zone of the person asking, such as their browser's. The Agent presents dates and
   * times in it. Omitted uses the project time zone.
   */
  readonly timeZone?: string
  /** BCP 47 language of the person asking. Omitted uses the project locale. */
  readonly locale?: string
  /**
   * What the turn may change without asking whoever sent it. Omitted uses their choice in the
   * thread, then their default, then `auto`.
   */
  readonly approvalMode?: AgentApprovalMode
  /** Title to stamp on the thread when one is created. */
  readonly title?: string
  /**
   * Where a thread this creates runs: on its owner's computer, which claims its turns, or, when
   * omitted, in the cloud. An existing thread keeps its own.
   */
  readonly runsOn?: "computer"
  /** The computer and folder a computer's thread this creates runs in. */
  readonly computer?: AgentThreadComputer
  /** Explicit id for the trigger (user) message. Defaults to a generated id. */
  readonly messageId?: string
  /** Caller principal for privileged integrations; scoped runtimes use their authorization principal. */
  readonly principal?: Principal
}

/** An earlier message to replace, and the turn its new text starts. */
export interface EditAgentMessageInput {
  /** The conversation thread containing the message to edit. */
  readonly threadId: string
  /** The existing user message to replace and rewind from. */
  readonly messageId: string
  /** Updated user text. Omitted when attachments are the whole message. */
  readonly text?: string
  /** Blob-backed files attached to the edited message. */
  readonly attachments?: readonly FileRef[]
  /** Structured page/object context snapshotted onto the edited user message. */
  readonly context?: readonly AgentContextEntryInput[]
  /** Configured language model selected for the re-run. Omitted uses routing or the agent default. */
  readonly model?: LanguageModelRef
  /** Reasoning effort or token budget for the re-run. Omitted uses the model's default. */
  readonly reasoning?: AgentReasoning
  readonly timeZone?: string
  readonly locale?: string
  readonly approvalMode?: AgentApprovalMode
  /** Explicit id for the replacement user message. Defaults to a generated id. */
  readonly nextMessageId?: string
  /** Caller principal for privileged integrations; scoped runtimes use their authorization principal. */
  readonly principal?: Principal
}

/** What a turn's model is chosen from. */
export interface AgentRequestModels {
  readonly language?: LanguageModelCatalog
  /** Picks the model of a turn that names none; absent without tiers and `models.decision`. */
  readonly router?: TurnModelRouter
}

export interface RequestAgentRunResult {
  /** The durable queued run exactly as it was created (`status: "queued"`, attempt 0). */
  readonly run: ConversationAgentRunRecord
  /** The enqueued job id, when the queue returns one. */
  readonly jobId?: string
  /** Whether this call created the thread. */
  readonly createdThread: boolean
}

/**
 * Trigger an agent turn.
 *
 * The user message and a `queued` run are persisted atomically before the queue intent is
 * published. This makes accepted work visible immediately and lets refresh reconstruct queue state.
 * The run's thread claim is the single-flight authority; a second request receives
 * `active_run_exists` before it can leave an orphan message.
 */
export async function requestAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: AgentRequestModels,
  input: RequestAgentRunInput
): Promise<RequestAgentRunResult> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertNoAgentSelector(input)
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const trigger = triggerParts(input)
  const continued = input.continue ? await continuedSelection(runtime, models.language, input) : {}
  const selection = {
    model: input.model ?? continued.model,
    reasoning: input.reasoning ?? continued.reasoning,
  }
  const settings = requesterSettings(input)
  if (input.approvalMode !== undefined) assertAgentApprovalMode(input.approvalMode)

  // Any other turn's spec is checked now, before anything is written. A routed turn holds its
  // router until its model is picked, last.
  const routed = routedTurn(models.router, selection, input)
  const requested =
    routed ?? (await resolveConversationRunSpec({ models: models.language, selection, settings }))
  assertAttachments(input.attachments)

  // Resolve context before creating a thread: invalid or inaccessible references must not leave an
  // empty conversation behind. The resulting parts are the exact snapshot persisted below.
  const contextParts = await resolveAgentContextParts(runtime, input.context)

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  // Attribution comes from the exact capability/execution pair, never the optional context cache
  // on the runtime. `input.principal` remains available to unrestricted server integrations that
  // have already authenticated their request.
  const principal =
    authority.type === "principal"
      ? authority.context.principal
      : (input.principal ?? SYSTEM_PRINCIPAL)
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)

  const existingThread = input.threadId
    ? await agents.threads.getById({ projectId, id: input.threadId })
    : null
  if (existingThread) assertThreadAcceptsRun(existingThread, principal)
  if (input.runsOn !== undefined && input.runsOn !== "computer") {
    throw new AgentRequestError("invalid_message", `[Sixb] 'runsOn' must be "computer" or omitted.`)
  }
  if (!existingThread) assertComputerPlaceRequest(input.runsOn, input.computer)
  const runsOn = existingThread ? existingThread.runsOn : input.runsOn
  // The message's mode, else the sender's in the thread.
  const approvalMode =
    input.approvalMode ??
    (await resolveAgentApprovalMode(agents, { projectId, principal, threadId: existingThread?.id }))
      .approvalMode

  const place = turnPlace(runsOn, existingThread ? existingThread.computer : input.computer)

  // Last before anything is written, so a message the checks above refuse never reaches the
  // decision model. Concurrent messages to an idle thread can still each ask before one of them is
  // refused with `active_run_exists` below.
  const selected =
    "router" in requested
      ? await routedConversationRunSpec({
          ...requested,
          agents,
          projectId,
          previous: existingThread
            ? await latestConversationRun(agents, projectId, existingThread.id)
            : undefined,
          place,
          settings,
          language: models.language,
        })
      : requested
  const spec: ConversationAgentRunSpec = Object.freeze({ ...selected, approvalMode, ...place })

  const createdThread = existingThread === null
  const thread =
    existingThread ??
    (await createThread(agents, {
      projectId,
      threadId: input.threadId,
      title: input.title,
      principal,
      runsOn,
      ...(input.computer === undefined ? {} : { computer: input.computer }),
    }))

  const triggerMessageId = input.messageId ?? createAgentMessageId()
  let run: ConversationAgentRunRecord
  let superseded: readonly AgentApprovalRecord[] = []
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      await tx.executions.create(durableExecution)
      // The model learns, once, how the calls it made earlier ended: the ones still waiting are
      // set aside by this message.
      const reported = createdThread
        ? { parts: [], superseded: [] }
        : await reportAgentApprovals(agents, {
            projectId,
            threadId: thread.id,
            messageId: triggerMessageId,
          })
      superseded = reported.superseded
      await agents.messages.append({
        id: triggerMessageId,
        projectId,
        threadId: thread.id,
        runId: null,
        role: "user",
        parts: [
          ...reported.parts,
          ...contextParts,
          ...trigger,
          ...(input.attachments ?? []).map((fileRef) => ({ type: "file" as const, fileRef })),
        ],
        authorPrincipal: principal,
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: thread.id,
        triggerMessageId,
        spec,
      })
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      throw new AgentRequestError("active_run_exists", error.message)
    }
    throw error
  }

  await announceAgentApprovals(runtime.broker, superseded)
  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)

  return {
    run,
    ...(jobId ? { jobId } : {}),
    createdThread,
  }
}

/** Whether a stored message is a user-authored prompt that can be edited in place. */
export function isEditableAgentMessage(
  message: Pick<AgentMessageRecord, "role" | "parts">
): boolean {
  if (message.role !== "user") return false
  if (message.parts.some((part) => part.type === "continuation")) return false
  return countsAsThreadMessage(message)
}

/**
 * Edit an earlier user message in place: the thread loses that message and everything after it,
 * and the edited message starts a new turn.
 *
 * On an idle thread the rewind and the new turn are one transaction. While a turn runs, the edit
 * waits in the thread's inbox, sent now: the turn stops, and its end rewinds the thread and starts
 * the edited message (see `startQueuedAgentTurnFromInbox`), so nothing the stopped turn still
 * writes lands after the edit.
 *
 * Historical `agent_runs` and `executions` remain intact for AI usage and cost accounting.
 */
export async function editAgentMessage(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: AgentRequestModels,
  input: EditAgentMessageInput,
  blobStorage?: RewindBlobStorage
): Promise<SendAgentMessageResult> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertNoAgentSelector(input)
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)

  const trigger = triggerParts(input)
  const selection = { model: input.model, reasoning: input.reasoning }
  const settings = requesterSettings(input)
  if (input.approvalMode !== undefined) assertAgentApprovalMode(input.approvalMode)

  const routed = routedTurn(models.router, selection, input)
  const requested =
    routed ?? (await resolveConversationRunSpec({ models: models.language, selection, settings }))
  assertAttachments(input.attachments)

  const contextParts = await resolveAgentContextParts(runtime, input.context)
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const principal =
    authority.type === "principal"
      ? authority.context.principal
      : (input.principal ?? SYSTEM_PRINCIPAL)

  const thread = await agents.threads.getById({ projectId, id: input.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${input.threadId}' not found.`
    )
  }
  assertThreadAcceptsMessages(thread, principal)

  const target = await agents.messages.getById({ projectId, id: input.messageId })
  if (!target || target.threadId !== thread.id) {
    throw new AgentRequestError(
      "message_not_found",
      `[Sixb] Agent message '${input.messageId}' not found in thread '${thread.id}'.`
    )
  }
  assertEditableMessageAuthority(thread, target, principal)

  const tail = await listAllThreadMessagesFromSeq(agents, projectId, thread.id, target.seq)
  assertParticipantCanRewindTail(thread, tail, principal)
  const rewoundRuns = await listRewoundConversationRuns(agents, projectId, thread.id, tail)
  assertRewindsWholeTurns(target, tail, rewoundRuns)

  const approvalMode =
    input.approvalMode ??
    (await resolveAgentApprovalMode(agents, { projectId, principal, threadId: thread.id }))
      .approvalMode

  // The edited turn runs where the thread runs now, like any message sent to it, and is routed
  // against the turn it continues: the newest one the rewind keeps.
  const place = turnPlace(thread.runsOn, thread.computer)
  const selected =
    "router" in requested
      ? await routedConversationRunSpec({
          ...requested,
          agents,
          projectId,
          previous: await latestRetainedConversationRun(agents, projectId, thread.id, tail),
          place,
          settings,
          language: models.language,
        })
      : requested
  const spec: ConversationAgentRunSpec = Object.freeze({ ...selected, approvalMode, ...place })

  const edit: AgentMessageEdit = {
    target,
    messageId: input.nextMessageId ?? createAgentMessageId(),
    authorPrincipal: principal,
    parts: [
      ...contextParts,
      ...trigger,
      ...(input.attachments ?? []).map((fileRef) => ({ type: "file" as const, fileRef })),
    ],
  }

  // Checked before anything stops: an edit the budget refuses must not end the turn it replaces.
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)

  if (thread.activeRunId !== null) {
    const item = await deferAgentMessageEdit(runtime, execution, thread, edit, {
      spec,
      settings,
      blobStorage,
    })
    return { kind: "inbox", item }
  }

  const documents = await rewoundTurnDocuments(runtime, blobStorage, rewoundRuns, tail)

  let run: ConversationAgentRunRecord
  let rewind: AgentThreadRewind | undefined
  let superseded: readonly AgentApprovalRecord[] = []
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const txAgents = tx.agents
      if (!txAgents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }

      rewind = await rewindAgentThread(tx, txAgents, {
        projectId,
        thread,
        messageId: edit.target.id,
        editor: principal,
        documents,
      })

      await tx.executions.create(durableExecution)
      const reported = await reportAgentApprovals(txAgents, {
        projectId,
        threadId: thread.id,
        messageId: edit.messageId,
      })
      superseded = reported.superseded

      await txAgents.messages.append({
        id: edit.messageId,
        projectId,
        threadId: thread.id,
        runId: null,
        role: "user",
        parts: [...reported.parts, ...edit.parts],
        authorPrincipal: principal,
      })

      return txAgents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: thread.id,
        triggerMessageId: edit.messageId,
        spec,
      })
    })
  } catch (error) {
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      throw new AgentRequestError("active_run_exists", error.message)
    }
    throw error
  }

  await announceAgentThreadRewind(runtime, rewind, superseded)
  await publishRunActivity(runtime, run)
  await dispatchAgentRun(runtime, agents, runId)
  return { kind: "turn", run, createdThread: false }
}

/** Where a rewind reads the documents that restore the canvases a rewound turn wrote. */
type RewindBlobStorage = Pick<BlobStorage, "open" | "put">

/** An edit of an earlier message: the message it replaces, and the one that replaces it. */
interface AgentMessageEdit {
  readonly target: AgentMessageRecord
  readonly messageId: string
  readonly authorPrincipal: Principal
  readonly parts: readonly AgentMessagePart[]
}

/**
 * Stop the running turn so the edit starts after it: the edit waits in the thread's inbox, sent
 * now, and the turn's end rewinds the thread and starts it. Stopping a turn is for whoever may: the
 * person who asked for it, or the thread's owner. A newer edit replaces one still waiting.
 */
async function deferAgentMessageEdit(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  thread: AgentThreadRecord,
  edit: AgentMessageEdit,
  options: {
    readonly spec: ConversationAgentRunSpec
    readonly settings: RequesterSettings
    readonly blobStorage: RewindBlobStorage | undefined
  }
): Promise<AgentInboxItemRecord> {
  const { spec, settings } = options
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const active = thread.activeRunId
    ? await agents.runs.getById({ projectId, id: thread.activeRunId })
    : null
  if (active?.kind !== "conversation") {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }
  // The turn's end starts the edit as the person who sent it: a request no person sent, with sign-in
  // off, leaves no one to start it as.
  if (!execution.requestedBy) {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' is answering, and an edit without a signed-in sender cannot wait for it: stop the answer, then edit.`
    )
  }

  const mayStop =
    principalsEqual(edit.authorPrincipal, thread.ownerPrincipal) ||
    (await askedForTurn(runtime, active, edit.authorPrincipal))
  if (!mayStop) {
    throw new AgentRequestError(
      "not_run_requester",
      `[Sixb] Agent thread '${thread.id}' runs a turn someone else asked for: only they or the thread's owner can stop it. Edit the message once it ends.`
    )
  }

  // The request that sends it is recorded with it: the turn that starts it once this request is
  // gone runs as that request's child.
  const request = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )

  for (const waiting of await agents.inbox.list({ projectId, threadId: thread.id })) {
    if (
      waiting.replacesMessageId !== undefined &&
      principalsEqual(waiting.authorPrincipal, edit.authorPrincipal)
    ) {
      await agents.inbox.remove({ projectId, threadId: thread.id, id: waiting.id })
    }
  }

  const { item } = await agents.inbox.enqueue({
    id: createAgentInboxItemId(),
    projectId,
    threadId: thread.id,
    messageId: edit.messageId,
    authorPrincipal: edit.authorPrincipal,
    mode: "queue",
    immediate: true,
    replacesMessageId: edit.target.id,
    parts: edit.parts,
    // Routed now, against the turn the edit continues: the stopped turn is not one of those.
    spec: {
      model: spec.model,
      ...(spec.reasoning === undefined ? {} : { reasoning: spec.reasoning }),
      approvalMode: spec.approvalMode,
    },
    ...settings,
    executionId: request.id,
  })

  // Taken from the turn before it stops: it would read them at its next step.
  await queueWaitingSteers(agents, projectId, thread.id, edit.authorPrincipal)
  await stopTurnBefore(runtime, execution, active, options.blobStorage)
  // The turn may have ended before the edit reached the inbox, its end reading none of it.
  await startIfThreadIdle(runtime, execution, thread.id, options.blobStorage)
  return item
}

/** What a rewind took back, for the events that tell watchers. */
interface AgentThreadRewind {
  readonly restoredVersions: readonly PublishedArtifactVersion["version"][]
  readonly cancelledApprovals: readonly AgentApprovalRecord[]
}

/**
 * Take the thread back to just before the edited message, in the caller's transaction: undo the
 * artifact writes of the turns it removes, newest first, drop their approvals and the summaries
 * that saw them, then delete the message and everything after it. It checks again what the edit
 * checked, as the thread may have moved on since, and writes nothing when a check fails.
 */
async function rewindAgentThread(
  tx: Storage,
  agents: AgentStorage,
  input: {
    readonly projectId: string
    readonly thread: AgentThreadRecord
    /** The edited message: the thread keeps what came before it. */
    readonly messageId: string
    readonly editor: Principal
    /** Restore documents of the rewound turns' canvases, read before the transaction. */
    readonly documents: ReadonlyMap<string, Record<string, FileRef>>
  }
): Promise<AgentThreadRewind> {
  const { projectId, thread, editor } = input

  const target = await agents.messages.getById({ projectId, id: input.messageId })
  if (!target || target.threadId !== thread.id) {
    throw new AgentRequestError(
      "message_not_found",
      `[Sixb] Agent message '${input.messageId}' not found in thread '${thread.id}'.`
    )
  }
  assertEditableMessageAuthority(thread, target, editor)

  const tail = await listAllThreadMessagesFromSeq(agents, projectId, thread.id, target.seq)
  assertParticipantCanRewindTail(thread, tail, editor)
  const rewoundRuns = await listRewoundConversationRuns(agents, projectId, thread.id, tail)
  assertRewindsWholeTurns(target, tail, rewoundRuns)

  const restored = new Map<string, PublishedArtifactVersion["version"]>()
  if (tx.artifacts) {
    for (const { run, later } of oldestFirst(rewoundRuns, tail)) {
      const trigger = tail.find((message) => message.id === run.triggerMessageId)
      const undone = await tx.artifacts.undoTurnWrites({
        projectId,
        turnRunId: run.id,
        laterTurnRunIds: later,
        documents: input.documents.get(run.id) ?? {},
        ...(trigger?.authorPrincipal ? { requester: trigger.authorPrincipal } : {}),
      })
      for (const entry of undone.restored) restored.set(entry.artifact.id, entry.version)
      for (const deletedId of undone.deleted) restored.delete(deletedId)
    }
  }

  const approvals = await agents.approvals.rewind({
    projectId,
    threadId: thread.id,
    runIds: rewoundRuns.map((run) => run.id),
    clearedMessageIds: tail.map((message) => message.id),
  })
  await agents.checkpoints.deleteAfterSeq({
    projectId,
    threadId: thread.id,
    afterSeq: target.seq - 1,
  })
  await agents.messages.deleteFromSeq({ projectId, threadId: thread.id, fromSeq: target.seq })
  await queueWaitingSteers(agents, projectId, thread.id, editor)

  return { restoredVersions: [...restored.values()], cancelledApprovals: approvals.cancelled }
}

/**
 * The editor's steers still waiting were written for a turn the edit takes back: they wait for the
 * next turn instead, where the tray shows them to keep or withdraw. Someone else's stay as they are.
 */
async function queueWaitingSteers(
  agents: AgentStorage,
  projectId: string,
  threadId: string,
  editor: Principal
): Promise<void> {
  const waiting = await agents.inbox.list({ projectId, threadId, includeClaimed: false })
  for (const item of waiting) {
    if (item.mode !== "steer" || item.immediate) continue
    if (!principalsEqual(item.authorPrincipal, editor)) continue

    try {
      await agents.inbox.update({ projectId, threadId, id: item.id, mode: "queue" })
    } catch (error) {
      // The stopping turn took it meanwhile: its end lets it go, and the rewind queues it then.
      if (error instanceof AgentStorageError && error.code === "invalid_state") continue
      throw error
    }
  }
}

/** The documents that restore the canvases the rewound turns wrote, read before the rewind. */
async function rewoundTurnDocuments(
  runtime: SixbRuntimeContext,
  blobStorage: RewindBlobStorage | undefined,
  rewoundRuns: readonly ConversationAgentRunRecord[],
  tail: readonly AgentMessageRecord[]
): Promise<ReadonlyMap<string, Record<string, FileRef>>> {
  const documents = new Map<string, Record<string, FileRef>>()
  const artifacts = runtime.storage.artifacts
  if (!artifacts || !blobStorage) return documents

  for (const { run, later } of oldestFirst(rewoundRuns, tail)) {
    documents.set(
      run.id,
      await undoneTurnDocuments(
        { projectId: runtime.projectId, storage: artifacts, blobStorage },
        run.id,
        later
      )
    )
  }
  return documents
}

/**
 * The rewound turns oldest first, each with the turns after it: undone together, an artifact
 * several of them wrote goes back to before the first, as no one else wrote it in between. Turns
 * follow their trigger messages through the thread, and a retry follows the attempt it replaced.
 */
function oldestFirst(
  rewoundRuns: readonly ConversationAgentRunRecord[],
  tail: readonly AgentMessageRecord[]
): readonly { readonly run: ConversationAgentRunRecord; readonly later: readonly string[] }[] {
  const seqOf = new Map(tail.map((message) => [message.id, message.seq]))
  const started = (run: ConversationAgentRunRecord) => (run.startedAt ?? run.createdAt).getTime()
  const ordered = [...rewoundRuns].sort(
    (left, right) =>
      (seqOf.get(left.triggerMessageId) ?? 0) - (seqOf.get(right.triggerMessageId) ?? 0) ||
      started(left) - started(right) ||
      left.attempt - right.attempt
  )

  return ordered.map((run, index) => ({
    run,
    later: ordered.slice(index + 1).map((each) => each.id),
  }))
}

async function announceAgentThreadRewind(
  runtime: SixbRuntimeContext,
  rewind: AgentThreadRewind | undefined,
  superseded: readonly AgentApprovalRecord[]
): Promise<void> {
  await announceArtifactUpdates(runtime.events, rewind?.restoredVersions ?? [])
  await announceAgentApprovals(runtime.broker, [
    ...(rewind?.cancelledApprovals ?? []),
    ...superseded,
  ])
}

function assertEditableMessageAuthority(
  _thread: AgentThreadRecord,
  target: AgentMessageRecord,
  principal: Principal
): void {
  if (!isEditableAgentMessage(target)) {
    throw new AgentRequestError(
      "message_not_editable",
      `[Sixb] Only user-authored messages can be edited.`
    )
  }
  if (
    principal.type === "user" &&
    (!target.authorPrincipal || !principalsEqual(target.authorPrincipal, principal))
  ) {
    throw new AgentRequestError(
      "not_message_author",
      `[Sixb] Only the author of message '${target.id}' can edit it.`
    )
  }
}

function assertParticipantCanRewindTail(
  thread: AgentThreadRecord,
  tail: readonly AgentMessageRecord[],
  principal: Principal
): void {
  if (principal.type !== "user" || principalsEqual(principal, thread.ownerPrincipal)) return

  const erasesOthers = tail.some(
    (message) =>
      message.role === "user" &&
      countsAsThreadMessage(message) &&
      message.authorPrincipal !== undefined &&
      !principalsEqual(message.authorPrincipal, principal)
  )
  if (erasesOthers) {
    throw new AgentRequestError(
      "not_thread_owner",
      "[Sixb] Only the thread's owner can rewind past another person's messages."
    )
  }
}

/**
 * An edit takes back whole turns: each turn it rewinds answered a message it removes. A message a
 * turn read while it was answering, as a steer, sits inside that turn: rewinding from it would
 * keep the turn's first part in the chat and undo everything the turn did.
 */
function assertRewindsWholeTurns(
  target: AgentMessageRecord,
  tail: readonly AgentMessageRecord[],
  rewoundRuns: readonly ConversationAgentRunRecord[]
): void {
  const removed = new Set(tail.map((message) => message.id))
  const cut = rewoundRuns.find((run) => !removed.has(run.triggerMessageId))
  if (!cut) return

  throw new AgentRequestError(
    "message_not_editable",
    `[Sixb] Agent message '${target.id}' came in while the Agent was answering message '${cut.triggerMessageId}': edit that message instead.`
  )
}

async function listAllThreadMessagesFromSeq(
  agents: AgentStorage,
  projectId: string,
  threadId: string,
  fromSeq: number
): Promise<readonly AgentMessageRecord[]> {
  const messages: AgentMessageRecord[] = []
  const afterSeq = fromSeq - 1
  for (;;) {
    const page = await agents.messages.list({
      projectId,
      threadId,
      afterSeq,
      order: "asc",
      limit: 200,
      offset: messages.length,
    })
    messages.push(...page.messages)
    if (!page.hasMore || page.messages.length === 0) return messages
  }
}

/** Conversation runs triggered at or after the rewound message, newest first. */
async function listRewoundConversationRuns(
  agents: AgentStorage,
  projectId: string,
  threadId: string,
  tail: readonly AgentMessageRecord[]
): Promise<readonly ConversationAgentRunRecord[]> {
  const removedMessageIds = new Set(tail.map((message) => message.id))
  const removedRunIds = new Set(
    tail.flatMap((message) => (message.runId === null ? [] : [message.runId]))
  )
  const found: ConversationAgentRunRecord[] = []
  for (let offset = 0; ; ) {
    const page = await agents.runs.list({
      projectId,
      threadId,
      kinds: ["conversation"],
      order: "desc",
      limit: 100,
      offset,
    })
    for (const run of page.runs) {
      if (
        run.kind === "conversation" &&
        (removedMessageIds.has(run.triggerMessageId) || removedRunIds.has(run.id))
      ) {
        found.push(run)
      }
    }
    offset += page.runs.length
    if (!page.hasMore || page.runs.length === 0) return found
  }
}

/**
 * The newest turn an edit keeps: its trigger message is still in the thread, before the edited one.
 * Turns the edit rewinds answered a message of `tail`; turns an earlier edit rewound answered a
 * message that is gone.
 */
async function latestRetainedConversationRun(
  agents: AgentStorage,
  projectId: string,
  threadId: string,
  tail: readonly AgentMessageRecord[]
): Promise<ConversationAgentRunRecord | undefined> {
  const notRetained = new Set(tail.map((message) => message.id))

  for (let offset = 0; ; ) {
    const page = await agents.runs.list({
      projectId,
      threadId,
      kinds: ["conversation"],
      order: "desc",
      limit: 50,
      offset,
    })

    for (const run of page.runs) {
      if (run.kind !== "conversation" || notRetained.has(run.triggerMessageId)) continue
      if (await agents.messages.getById({ projectId, id: run.triggerMessageId })) return run
      notRetained.add(run.triggerMessageId)
    }

    offset += page.runs.length
    if (!page.hasMore || page.runs.length === 0) return undefined
  }
}

/** A failed turn, or one its worker died during, can run again from the same trigger message. */
export function isRetryableAgentRun(
  run: Pick<ConversationAgentRunRecord, "status" | "finishReason">
): boolean {
  return (
    run.status === "failed" || (run.status === "cancelled" && run.finishReason === "interrupted")
  )
}

/** Retry a failed turn as a new child execution while reusing its immutable trigger message. */
export async function retryAgentRun(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  failedRun: ConversationAgentRunRecord,
  /**
   * Where a canvas the retry puts back stores its document; without it, the document is left
   * behind, and brought up to the content by whoever loads it next.
   */
  blobStorage?: Pick<BlobStorage, "open" | "put">
): Promise<RequestAgentRunResult> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  if (!isRetryableAgentRun(failedRun)) {
    throw new AgentRequestError(
      "run_not_retryable",
      `[Sixb] Only failed or interrupted Agent runs can be retried.`
    )
  }

  const agents = requireAgentStorage(runtime)
  const thread = await agents.threads.getById({
    projectId: runtime.projectId,
    id: failedRun.threadId,
  })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${failedRun.threadId}' was not found.`
    )
  }
  assertSandboxExecutionAvailable(thread)
  if (
    authority.type === "principal" &&
    thread.runsOn === "computer" &&
    !principalsEqual(authority.context.principal, thread.ownerPrincipal)
  ) {
    throw new AgentRequestError(
      "not_thread_owner",
      `[Sixb] Agent thread '${thread.id}' runs on its owner's computer, as them: only its owner can retry a turn in it.`
    )
  }
  const runId = createAgentRunId()
  const durableExecution = await prepareDurableAgentExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)

  // A canvas put back takes its restore point as a change to its document, made before the undo.
  const artifacts = runtime.storage.artifacts
  const documents =
    artifacts && blobStorage
      ? await undoneTurnDocuments(
          { projectId: runtime.projectId, storage: artifacts, blobStorage },
          failedRun.id
        )
      : {}

  const { run, undone } = await runtime.storage.transaction(async (tx) => {
    const agents = tx.agents
    if (!agents) {
      throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
    }
    await agents.messages.deleteByRunId({
      projectId: runtime.projectId,
      threadId: failedRun.threadId,
      runId: failedRun.id,
    })
    // What the failed turn wrote goes with what it said, so the retry starts clean: each artifact
    // nobody changed since is put back as it was, or deleted when the turn created it and nobody
    // but its requester commented on it. Its children wrote as the turn.
    const trigger = await agents.messages.getById({
      projectId: runtime.projectId,
      id: failedRun.triggerMessageId,
    })
    const requester = trigger?.authorPrincipal

    const undone = await tx.artifacts?.undoTurnWrites({
      projectId: runtime.projectId,
      turnRunId: failedRun.id,
      documents,
      ...(requester ? { requester } : {}),
    })
    await tx.executions.create(durableExecution)
    const run = await agents.runs.create({
      id: runId,
      projectId: runtime.projectId,
      executionId: durableExecution.id,
      threadId: failedRun.threadId,
      triggerMessageId: failedRun.triggerMessageId,
      spec: inPlace(
        thread,
        failedRun.spec ??
          (await resolveConversationRunSpec({ models, selection: {}, settings: {} }))
      ),
    })
    return { run, undone }
  })
  await announceArtifactUpdates(
    runtime.events,
    (undone?.restored ?? []).map(({ version }) => version)
  )
  await publishRunActivity(runtime, run)
  const jobId = await dispatchAgentRun(runtime, agents, runId)
  return { run, ...(jobId ? { jobId } : {}), createdThread: false }
}

/** Where a resume left a paused turn. */
export type AgentTurnResume =
  | { readonly status: "resumed"; readonly run: ConversationAgentRunRecord }
  | { readonly status: Exclude<AgentTurnReadiness, "ready"> }

/** How a message sent to a thread is delivered while a turn runs. */
export const AGENT_MESSAGE_DELIVERIES = ["auto", "steer", "queue", "send_now"] as const
export type AgentMessageDelivery = (typeof AGENT_MESSAGE_DELIVERIES)[number]

export interface SendAgentMessageInput
  extends Omit<RequestAgentRunInput, "principal" | "continue"> {
  readonly threadId: string
  /**
   * `auto` (the default) starts a turn, and refuses while another one runs. `steer` reaches the
   * running turn at its next step. `queue` starts a turn once the running one ends. `send_now` stops
   * the running turn and starts this message after it.
   */
  readonly delivery?: AgentMessageDelivery
}

/** What a message became: the turn it started, or the inbox item that waits for one. */
export type SendAgentMessageResult =
  | {
      readonly kind: "turn"
      readonly run: ConversationAgentRunRecord
      readonly createdThread: boolean
    }
  | { readonly kind: "inbox"; readonly item: AgentInboxItemRecord }

/**
 * Send a message to a conversation, delivered as asked.
 *
 * A steer or a send-now reaches only the turn its requester asked for: it runs as them. Any reader
 * may queue a message, which starts as a turn of their own.
 */
export async function sendAgentMessage(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: AgentRequestModels,
  input: SendAgentMessageInput,
  blobStorage?: RewindBlobStorage
): Promise<SendAgentMessageResult> {
  const delivery = input.delivery ?? "auto"
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const thread = await agents.threads.getById({ projectId, id: input.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${input.threadId}' was not found.`
    )
  }
  assertConversationThread(thread)

  const startTurn = async (): Promise<SendAgentMessageResult> => {
    const { delivery: _delivery, ...request } = input
    const result = await requestAgentRun(runtime, execution, models, request)
    return { kind: "turn", run: result.run, createdThread: result.createdThread }
  }

  // Nothing runs, so there is nothing to steer or wait behind.
  const activeId = thread.activeRunId
  if (delivery === "auto" || activeId === null) return startTurn()

  const active = await agents.runs.getById({ projectId, id: activeId })
  const requester = active
    ? (await runtime.storage.executions.getById({ projectId, id: active.executionId }))?.requestedBy
    : undefined
  const principal = messageAuthor(runtime, execution)
  const requesterOfTurn = requester !== undefined && principalsEqual(requester, principal)

  if (!requesterOfTurn && delivery !== "queue") {
    throw new AgentRequestError(
      "not_run_requester",
      `[Sixb] Agent thread '${thread.id}' runs a turn someone else asked for: only they can steer it or send now. Queue the message for your own turn.`
    )
  }

  const settings = requesterSettings(input)
  const contextParts = await resolveAgentContextParts(runtime, input.context)
  const trigger = deliveredParts(input, delivery)
  const spec = {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
  }
  // The request that sends it is recorded with it: a turn that starts it once this request is gone
  // runs as that request's child, as a turn this request started would have.
  assertRequestAuthorityCanRunAgent(runtime)
  const request = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )
  const { item } = await agents.inbox.enqueue({
    id: createAgentInboxItemId(),
    projectId,
    threadId: thread.id,
    messageId: input.messageId ?? createAgentMessageId(),
    authorPrincipal: principal,
    mode: delivery === "steer" ? "steer" : "queue",
    parts: [...contextParts, ...trigger],
    ...(Object.keys(spec).length === 0 ? {} : { spec }),
    ...settings,
    ...(delivery === "send_now" ? { immediate: true } : {}),
    executionId: request.id,
  })

  if (delivery === "send_now") {
    await stopTurnBefore(runtime, execution, active as ConversationAgentRunRecord, blobStorage)
  }
  await startIfThreadIdle(runtime, execution, thread.id, blobStorage)
  return { kind: "inbox", item }
}

/** What a message the caller sent may become once it waits in a thread's inbox. */
export interface PromoteAgentInboxItemInput {
  readonly threadId: string
  readonly itemId: string
  /** Edit what it says; its context and files stay as they are. */
  readonly text?: string
  readonly model?: LanguageModelRef
  readonly reasoning?: AgentReasoning
  readonly approvalMode?: AgentApprovalMode
  /** Steer the running turn with it, or keep it for the next turn. */
  readonly delivery?: "steer" | "queue"
  /** Stop the turn it waits behind, and start it now. */
  readonly immediate?: boolean
}

/**
 * Change a message waiting in a thread's inbox, before a turn reads it: what it says, the model it
 * asks for, where it goes, or that it goes now.
 *
 * Only the person who sent it may change it, and a message that steers or goes now reaches only the
 * turn its own requester asked for.
 */
export async function promoteAgentInboxItem(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: PromoteAgentInboxItemInput,
  blobStorage?: RewindBlobStorage
): Promise<AgentInboxItemRecord> {
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const thread = await agents.threads.getById({ projectId, id: input.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${input.threadId}' was not found.`
    )
  }
  assertConversationThread(thread)

  const item = await agents.inbox.getById({ projectId, id: input.itemId })
  if (!item || item.threadId !== thread.id) {
    throw new AgentRequestError(
      "invalid_message",
      `[Sixb] Agent inbox item '${input.itemId}' is not waiting in thread '${thread.id}'.`
    )
  }
  const principal = messageAuthor(runtime, execution)
  if (!principalsEqual(item.authorPrincipal, principal)) {
    throw new AgentRequestError(
      "not_run_requester",
      `[Sixb] Agent inbox item '${item.id}' was sent by someone else: only they can change it.`
    )
  }

  const active = thread.activeRunId
    ? await agents.runs.getById({ projectId, id: thread.activeRunId })
    : null
  const delivery = input.delivery ?? item.mode
  const turn = active?.kind === "conversation" ? active : null
  if ((delivery === "steer" || input.immediate === true) && turn) {
    if (!(await askedForTurn(runtime, turn, principal))) {
      throw new AgentRequestError(
        "not_run_requester",
        `[Sixb] Agent thread '${thread.id}' runs a turn someone else asked for: only they can steer it or send now. Keep the message queued for your own turn.`
      )
    }
  }

  const spec = {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
    ...(input.approvalMode === undefined ? {} : { approvalMode: input.approvalMode }),
  }
  const updated = await agents.inbox.update({
    projectId,
    threadId: thread.id,
    id: item.id,
    ...(input.delivery === undefined ? {} : { mode: input.delivery }),
    ...(input.text === undefined
      ? {}
      : {
          parts: [
            { type: "text" as const, text: input.text },
            ...item.parts.filter((part) => part.type !== "text"),
          ],
        }),
    // What it does not name stays as it asked: a new reasoning keeps its model.
    ...(Object.keys(spec).length === 0 ? {} : { spec: { ...item.spec, ...spec } }),
    ...(input.immediate === true ? { immediate: true } : {}),
  })
  if (!updated) {
    throw new AgentRequestError(
      "invalid_message",
      `[Sixb] Agent inbox item '${item.id}' is no longer waiting in thread '${thread.id}'.`
    )
  }
  if (input.immediate === true && turn) {
    await stopTurnBefore(runtime, execution, turn, blobStorage)
  }
  await startIfThreadIdle(runtime, execution, thread.id, blobStorage)
  return updated
}

/**
 * Take back a message waiting in a thread's inbox, before a turn reads it. Only the person who sent
 * it may withdraw it.
 */
export async function withdrawAgentInboxItem(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  input: { readonly threadId: string; readonly itemId: string }
): Promise<void> {
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const thread = await agents.threads.getById({ projectId, id: input.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${input.threadId}' was not found.`
    )
  }
  assertConversationThread(thread)
  const item = await agents.inbox.getById({ projectId, id: input.itemId })
  if (!item || item.threadId !== thread.id) {
    throw new AgentRequestError(
      "invalid_message",
      `[Sixb] Agent inbox item '${input.itemId}' is not waiting in thread '${thread.id}'.`
    )
  }
  if (!principalsEqual(item.authorPrincipal, messageAuthor(runtime, execution))) {
    throw new AgentRequestError(
      "not_run_requester",
      `[Sixb] Agent inbox item '${item.id}' was sent by someone else: only they can withdraw it.`
    )
  }
  const removed = await agents.inbox.remove({ projectId, threadId: thread.id, id: item.id })
  if (!removed) {
    throw new AgentRequestError(
      "invalid_message",
      `[Sixb] Agent inbox item '${item.id}' is no longer waiting in thread '${thread.id}': a turn read it.`
    )
  }
}

/** The person a message this request sends is from. */
function messageAuthor(runtime: SixbRuntimeContext, execution: ExecutionContext): Principal {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  return authority.type === "principal" ? authority.context.principal : SYSTEM_PRINCIPAL
}

/** Whether the person asked for this turn, which alone may steer it or send now. */
async function askedForTurn(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord,
  principal: Principal
): Promise<boolean> {
  const requester = (
    await runtime.storage.executions.getById({ projectId: runtime.projectId, id: run.executionId })
  )?.requestedBy
  return requester !== undefined && principalsEqual(requester, principal)
}

/**
 * Stop the turn a message waits behind, so the message starts now. A turn still running ends first,
 * and its end starts the message (see afterAgentRunFinished); one that never started has no end to
 * wait for, so it starts here.
 */
async function stopTurnBefore(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  active: ConversationAgentRunRecord,
  blobStorage: RewindBlobStorage | undefined
): Promise<void> {
  if (active.status === "running") {
    await cancelAgentRun(runtime, active)
    return
  }
  await cancelAgentRun(runtime, active).catch(() => undefined)
  await startQueuedAgentTurnFromInbox(
    runtime,
    execution,
    active,
    { onlyImmediate: true },
    blobStorage
  )
}

/**
 * Start what the caller left waiting once no turn holds the thread: the turn it waited behind ended
 * before the message reached the inbox, or before a stop reached it, so that end read none of it,
 * or it was someone else's, whose end starts their own messages first. It starts the caller's own
 * turn, as them, by the rules a turn's end applies. A failure leaves the message waiting for the
 * repair pass.
 */
async function startIfThreadIdle(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  threadId: string,
  blobStorage: RewindBlobStorage | undefined
): Promise<void> {
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  try {
    const thread = await agents.threads.getById({ projectId, id: threadId })
    // A turn holds it: that turn's end starts the message.
    if (!thread || thread.activeRunId !== null) return
    const {
      runs: [last],
    } = await agents.runs.list({
      projectId,
      threadId,
      kinds: ["conversation"],
      order: "desc",
      limit: 1,
    })
    if (last?.kind !== "conversation") return
    // A paused turn resumes first, and its end starts what waits: only a message sent now passes
    // it, setting its held calls aside as a message typed in the chat would.
    const onlyImmediate =
      isAwaitingApprovalRun(last) || !(await turnAnsweredEveryMessage(agents, last))
    await startQueuedAgentTurnFromInbox(runtime, execution, last, { onlyImmediate }, blobStorage)
  } catch (error) {
    console.error(
      `[Sixb] Could not start what waits in Agent thread '${threadId}'; the repair pass retries.`,
      error
    )
  }
}

/** The parts a message of its own carries: what it says, then the files it brings. */
function deliveredParts(
  input: Pick<SendAgentMessageInput, "text" | "attachments">,
  delivery: AgentMessageDelivery
): readonly AgentMessagePart[] {
  if (delivery === "steer" && (input.attachments?.length ?? 0) > 0) {
    throw new AgentRequestError(
      "invalid_attachment",
      "[Sixb] A message that steers a running turn carries no file: queue it for the next turn instead."
    )
  }
  assertAttachments(input.attachments)
  const text =
    typeof input.text === "string" && input.text.trim().length > 0
      ? [{ type: "text" as const, text: input.text }]
      : []
  const files = (input.attachments ?? []).map((fileRef) => ({ type: "file" as const, fileRef }))
  if (text.length === 0 && files.length === 0) {
    throw new AgentRequestError(
      "invalid_message",
      "[Sixb] An Agent message needs text or attachments."
    )
  }
  return [...text, ...files]
}

/** Where a queued turn started from: the thread moved on, nothing waited, or it started. */
export type AgentQueuedTurnStart =
  | { readonly status: "started"; readonly run: ConversationAgentRunRecord }
  | { readonly status: "nothing" }
  | { readonly status: "closed" }

/**
 * Start the next message the execution's requester queued for this thread, as them, from
 * `finishedRun`: a turn of the thread, whose model and reasoning carry over.
 *
 * It pops the item in the same transaction that writes its message and its run, so two turns
 * ending at once start one between them. `onlyImmediate` starts only a message someone sent now,
 * which is what a turn that did not answer (a stop, a failure) may follow.
 */
export async function startQueuedAgentTurnFromInbox(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  finishedRun: ConversationAgentRunRecord,
  input: { readonly onlyImmediate: boolean },
  blobStorage?: RewindBlobStorage
): Promise<AgentQueuedTurnStart> {
  resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId

  // The finished turn's spec is where a queued message starts: its model and reasoning, unless the
  // message names others. A turn too old to carry one has nothing to start from.
  const kept = finishedRun.spec
  if (!kept) return { status: "closed" }

  const thread = await agents.threads.getById({ projectId, id: finishedRun.threadId })
  if (!thread) return { status: "closed" }
  assertSandboxExecutionAvailable(thread)
  // Whom the turn runs as, and whose messages it starts: a turn starts only its requester's.
  const principal = execution.requestedBy
  if (!principal) return { status: "closed" }
  // Its owner's computer runs its turns as its owner: another's message waits for one of theirs.
  if (thread.runsOn === "computer" && !principalsEqual(principal, thread.ownerPrincipal)) {
    return { status: "closed" }
  }

  const runId = createAgentRunId()
  const durableExecution = await prepareResumedExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)
  const documents = await waitingEditDocuments(runtime, blobStorage, thread, principal)

  let started: ConversationAgentRunRecord | null
  let rewind: AgentThreadRewind | undefined
  let dropped: { readonly item: AgentInboxItemRecord; readonly reason: unknown } | undefined
  let superseded: readonly AgentApprovalRecord[] = []
  try {
    started = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      const item = await agents.inbox.takeNextQueued({
        projectId,
        threadId: thread.id,
        onlyImmediate: input.onlyImmediate,
        authorPrincipal: principal,
      })
      if (!item) return null

      // An edit takes the thread back to the message it replaces first. One the thread moved past
      // since it was sent (that message is gone) is dropped: the checks write nothing.
      if (item.replacesMessageId !== undefined) {
        try {
          rewind = await rewindAgentThread(tx, agents, {
            projectId,
            thread,
            messageId: item.replacesMessageId,
            editor: item.authorPrincipal,
            documents,
          })
        } catch (error) {
          if (!(error instanceof AgentRequestError)) throw error
          dropped = { item, reason: error }
          return null
        }
      }

      const inherited = await resolveAgentApprovalMode(agents, {
        projectId,
        principal,
        threadId: thread.id,
      })
      const approvalMode = item.spec?.approvalMode ?? inherited.approvalMode
      const spec = queuedConversationRunSpec(thread, kept, item, approvalMode)

      await tx.executions.create(durableExecution)
      // Like any message that starts a turn, it tells the model how its earlier calls ended, and
      // sets aside the ones still waiting.
      const reported = await reportAgentApprovals(agents, {
        projectId,
        threadId: thread.id,
        messageId: item.messageId,
      })
      superseded = reported.superseded
      await agents.messages.append({
        id: item.messageId,
        projectId,
        threadId: thread.id,
        runId: null,
        role: "user",
        parts: [...reported.parts, ...item.parts],
        authorPrincipal: item.authorPrincipal,
        createdAt: item.createdAt,
        ...(item.timeZone === undefined && item.locale === undefined
          ? {}
          : {
              metadata: {
                ...(item.timeZone === undefined ? {} : { timeZone: item.timeZone }),
                ...(item.locale === undefined ? {} : { locale: item.locale }),
              },
            }),
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: thread.id,
        triggerMessageId: item.messageId,
        spec,
      })
    })
  } catch (error) {
    // A turn took the thread meanwhile: its end starts this message, or its requester does.
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      return { status: "closed" }
    }
    throw error
  }
  if (dropped) {
    console.warn(
      `[Sixb] Dropped the edit of Agent message '${dropped.item.replacesMessageId}' waiting in thread '${thread.id}': it no longer applies.`,
      dropped.reason
    )
  }
  if (!started) return { status: "nothing" }

  await announceAgentThreadRewind(runtime, rewind, superseded)
  await publishRunActivity(runtime, started)
  await dispatchAgentRun(runtime, agents, runId)
  return { status: "started", run: started }
}

/**
 * The restore documents for the edit the caller's next queued message would make, read before
 * the transaction that starts it, as an edit on an idle thread reads them. Edits are always sent
 * now, so the caller's oldest message sent now is the one their turn takes first.
 */
async function waitingEditDocuments(
  runtime: SixbRuntimeContext,
  blobStorage: RewindBlobStorage | undefined,
  thread: AgentThreadRecord,
  principal: Principal
): Promise<ReadonlyMap<string, Record<string, FileRef>>> {
  if (!runtime.storage.artifacts || !blobStorage) return new Map()

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const waiting = await agents.inbox.list({ projectId, threadId: thread.id, includeClaimed: false })
  const next = waiting
    .filter((item) => item.immediate && principalsEqual(item.authorPrincipal, principal))
    .sort((left, right) => left.seq - right.seq)[0]
  if (next?.replacesMessageId === undefined) return new Map()

  const target = await agents.messages.getById({ projectId, id: next.replacesMessageId })
  if (!target || target.threadId !== thread.id) return new Map()

  const tail = await listAllThreadMessagesFromSeq(agents, projectId, thread.id, target.seq)
  const rewoundRuns = await listRewoundConversationRuns(agents, projectId, thread.id, tail)
  return rewoundTurnDocuments(runtime, blobStorage, rewoundRuns, tail)
}

/** A queued message's turn: the finished turn's spec, with the message's own choices over it. */
function queuedConversationRunSpec(
  thread: AgentThreadRecord,
  kept: ConversationAgentRunSpec,
  item: AgentInboxItemRecord,
  approvalMode: AgentApprovalMode
): ConversationAgentRunSpec {
  const model = item.spec?.model ?? kept.model
  // An edit's choices were made against the turn it continues: the stopped turn it rewinds passes
  // nothing on.
  const reasoning =
    item.spec?.reasoning ?? (item.replacesMessageId === undefined ? kept.reasoning : undefined)
  const timeZone = item.timeZone ?? kept.timeZone
  const locale = item.locale ?? kept.locale
  return inPlace(thread, {
    model,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
    approvalMode,
  })
}

/**
 * Resume a turn that paused on held calls, once its requester decided on all of them: a new turn
 * with the paused one's spec and the given mode, whose trigger message carries how each call ended,
 * and that the chat shows no text for. It checks what a retry checks, and throws what a retry
 * throws; there are no words for Sixb to pick a model from.
 *
 * It writes nothing while a call still waits or an approved one has not run (`waiting`), and once
 * the turn cannot resume (`closed`): a call was set aside, the turn was stopped or resumed already,
 * or a message moved the thread on.
 */
export async function resumeAgentTurn(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  models: LanguageModelCatalog | undefined,
  pausedRun: ConversationAgentRunRecord,
  input: { readonly approvalMode: AgentApprovalMode; readonly principal?: Principal }
): Promise<AgentTurnResume> {
  const authority = resolveExecutionScopeAuthorization(runtime.projectId, {
    execution,
    authorization: runtime.runtimeAuthorization,
  })
  if (!isAwaitingApprovalRun(pausedRun)) return { status: "closed" }

  const agents = requireAgentStorage(runtime)
  const projectId = runtime.projectId
  const scope = { projectId, runId: pausedRun.id }
  // Read first, so a decision that leaves calls waiting never meets a check below.
  const readiness = turnResumeReadiness(await listTurnApprovals(agents, scope))
  if (readiness !== "ready") return { status: readiness }

  assertAuthorized(runtime, { kind: "agent.run" })
  assertRequestAuthorityCanRunAgent(runtime)
  const thread = await agents.threads.getById({ projectId, id: pausedRun.threadId })
  if (!thread) {
    throw new AgentRequestError(
      "thread_not_found",
      `[Sixb] Agent thread '${pausedRun.threadId}' was not found.`
    )
  }
  assertSandboxExecutionAvailable(thread)

  const runId = createAgentRunId()
  const durableExecution = await prepareResumedExecution(runtime, execution, runId)
  await assertAiLimitPreflight(runtime, durableExecution)
  const spec = inPlace(
    thread,
    await resumedConversationRunSpec(models, pausedRun.spec, input.approvalMode)
  )
  const principal =
    authority.type === "principal"
      ? authority.context.principal
      : (input.principal ?? SYSTEM_PRINCIPAL)
  const triggerMessageId = createAgentMessageId()

  let run: ConversationAgentRunRecord
  try {
    run = await runtime.storage.transaction(async (tx) => {
      const agents = tx.agents
      if (!agents) {
        throw new AgentRequestError(
          "storage_unavailable",
          "[Sixb] Agent storage is not configured."
        )
      }
      // Checked again where it is written: a message sent meanwhile moved the thread on.
      const latest = await latestConversationRun(agents, projectId, pausedRun.threadId)
      if (latest?.id !== pausedRun.id) throw new TurnClosed()
      const approvals = await listTurnApprovals(agents, scope)
      if (turnResumeReadiness(approvals) !== "ready") throw new TurnClosed()

      // The report's compare-and-swap lets one of two racing final decisions resume the turn, and
      // a stop that lands first keeps it from resuming.
      const parts = await reportSettledAgentApprovals(agents, {
        projectId,
        threadId: pausedRun.threadId,
        messageId: triggerMessageId,
        resuming: true,
      })
      const reported = new Set(parts.map((part) => part.approvalId))
      const unreported = approvals.filter((approval) => approval.reportedInMessageId === undefined)
      if (!unreported.every((approval) => reported.has(approval.id))) throw new TurnClosed()

      await tx.executions.create(durableExecution)
      await agents.messages.append({
        id: triggerMessageId,
        projectId,
        threadId: pausedRun.threadId,
        runId: null,
        role: "user",
        parts,
        authorPrincipal: principal,
      })
      return agents.runs.create({
        id: runId,
        projectId,
        executionId: durableExecution.id,
        threadId: pausedRun.threadId,
        triggerMessageId,
        spec,
      })
    })
  } catch (error) {
    if (error instanceof TurnClosed) return { status: "closed" }
    // Another turn took the thread first; its message reports what this one would have.
    if (error instanceof AgentStorageError && error.code === "active_run_exists") {
      return { status: "closed" }
    }
    throw error
  }

  await publishRunActivity(runtime, run)
  await dispatchAgentRun(runtime, agents, runId)
  return { status: "resumed", run }
}

/** Rolls the resume's transaction back: the turn cannot resume. */
class TurnClosed extends Error {
  constructor() {
    super("[Sixb] The paused Agent turn can no longer resume.")
  }
}

/**
 * A resumed turn's execution. From a request, it is that request's child, like a retry. From the
 * paused turn's own execution, as the worker resumes it, it is a sibling of the paused turn: a
 * child of the request that started it, so that resumes never nest.
 */
async function prepareResumedExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  runId: string
): Promise<Omit<ExecutionRecord, "createdAt">> {
  if (execution.executor.type !== "agent" || execution.source.type !== "execution") {
    return prepareDurableAgentExecution(runtime, execution, runId)
  }

  const parent = await runtime.storage.executions.getById({
    projectId: runtime.projectId,
    id: execution.source.executionId,
  })
  if (!parent) {
    throw new AgentRequestError(
      "authority_not_inheritable",
      `[Sixb] Agent execution '${execution.id}' has no parent to resume under.`
    )
  }
  return createInheritedAgentExecutionRecord({ id: `exec_${randomUUID()}`, parent, runId })
}

/**
 * A turn's spec where its thread runs: a turn that runs again or goes on after approvals runs
 * where its first did, whatever spec it starts from.
 */
function inPlace(
  thread: AgentThreadRecord,
  spec: ConversationAgentRunSpec
): ConversationAgentRunSpec {
  const { runsOn: _runsOn, computer: _computer, ...rest } = spec
  return Object.freeze({ ...rest, ...turnPlace(thread.runsOn, thread.computer) })
}

/** The paused turn's spec, with defaults for a model that has since left the catalog. */
async function resumedConversationRunSpec(
  models: LanguageModelCatalog | undefined,
  paused: ConversationAgentRunSpec | undefined,
  approvalMode: AgentApprovalMode
): Promise<ConversationAgentRunSpec> {
  const kept =
    paused && models?.getByRef(paused.model)
      ? paused
      : await resolveConversationRunSpec({
          models,
          selection: {},
          settings: {
            ...(paused?.timeZone === undefined ? {} : { timeZone: paused.timeZone }),
            ...(paused?.locale === undefined ? {} : { locale: paused.locale }),
          },
        })
  return Object.freeze({ ...kept, approvalMode })
}

/**
 * A continuation picks up where the cut-short turn stopped, with its model and reasoning unless the
 * request chooses others. A model that has since left the catalog falls back to the defaults.
 */
async function continuedSelection(
  runtime: SixbRuntimeContext,
  models: LanguageModelCatalog | undefined,
  input: RequestAgentRunInput
): Promise<Pick<RequestAgentRunInput, "model" | "reasoning">> {
  const agents = requireAgentStorage(runtime)
  const threadId = input.threadId ?? ""
  if (!(await agents.threads.getById({ projectId: runtime.projectId, id: threadId }))) {
    throw new AgentRequestError(
      "thread_not_found",
      "[Sixb] An Agent continuation needs an existing thread."
    )
  }
  if (input.model !== undefined || input.reasoning !== undefined) return {}
  const spec = (await latestConversationRun(agents, runtime.projectId, threadId))?.spec
  if (!spec || !models?.getByRef(spec.model)) return {}
  return {
    model: spec.model,
    ...(spec.reasoning === undefined ? {} : { reasoning: spec.reasoning }),
  }
}

/** A turn Sixb picks the model of, with the words it judges. */
interface RoutedTurn {
  readonly router: TurnModelRouter
  readonly text: string
}

/**
 * Naming a model or a reasoning opts a turn out of routing: it runs that model, or the default, as
 * chosen. A continuation keeps the cut-short turn's model. A message of files alone is routed with
 * no words, which the router does not ask about.
 */
function routedTurn(
  router: TurnModelRouter | undefined,
  selection: Pick<RequestAgentRunInput, "model" | "reasoning">,
  input: Pick<RequestAgentRunInput, "text" | "continue">
): RoutedTurn | undefined {
  if (!router || input.continue === true) return undefined
  if (selection.model !== undefined || selection.reasoning !== undefined) return undefined

  return { router, text: input.text ?? "" }
}

/** The spec of a turn Sixb picks the model for, compared to the thread's previous turn. */
async function routedConversationRunSpec(
  input: RoutedTurn & {
    readonly agents: AgentStorage
    readonly projectId: string
    /** The turn this one continues, absent for a thread's first. */
    readonly previous: ConversationAgentRunRecord | undefined
    /** Where the turn runs: the previous turn's cache holds its prompt only if it ran there. */
    readonly place: AgentTurnPlace
    readonly settings: RequesterSettings
    readonly language: LanguageModelCatalog | undefined
  }
): Promise<ConversationAgentRunSpec> {
  const previous = input.previous && {
    run: input.previous,
    text: await messageWords(input.agents, input.projectId, input.previous.triggerMessageId),
  }
  const choice = await input.router.choose({ text: input.text, previous, place: input.place })

  return resolveConversationRunSpec({
    models: input.language,
    selection: { model: choice.model },
    settings: input.settings,
    tierProbabilities: choice.tierProbabilities,
  })
}

/** What a person wrote in a message, without the context or files sent with it. */
async function messageWords(
  agents: AgentStorage,
  projectId: string,
  messageId: string
): Promise<string | undefined> {
  const message = await agents.messages.getById({ projectId, id: messageId })
  if (!message) return undefined

  const words = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim()
  return words || undefined
}

async function latestConversationRun(
  agents: AgentStorage,
  projectId: string,
  threadId: string
): Promise<ConversationAgentRunRecord | undefined> {
  const { runs } = await agents.runs.list({
    projectId,
    threadId,
    kinds: ["conversation"],
    order: "desc",
    limit: 1,
  })
  return runs[0]?.kind === "conversation" ? runs[0] : undefined
}

/**
 * The words of the user, or the continuation Sixb words for them. Files alone are a message too:
 * their parts follow, and the model reads each one's description.
 */
function triggerParts(input: RequestAgentRunInput): readonly AgentMessagePart[] {
  if (input.continue === true) {
    if (input.text !== undefined || input.attachments?.length || input.context?.length) {
      throw new AgentRequestError(
        "invalid_message",
        "[Sixb] An Agent continuation carries no text, attachments, or context."
      )
    }
    return [{ type: "continuation" }]
  }
  if (typeof input.text === "string" && input.text.trim().length > 0) {
    return [{ type: "text", text: input.text }]
  }
  if (input.attachments?.length) return []

  throw new AgentRequestError(
    "invalid_message",
    "[Sixb] An Agent message needs text or attachments, or `continue: true` to continue the previous answer."
  )
}

function assertAttachments(attachments: readonly FileRef[] | undefined): void {
  for (const [index, attachment] of (attachments ?? []).entries()) {
    if (!isValidFileRef(attachment)) {
      throw new AgentRequestError(
        "invalid_attachment",
        `[Sixb] Attachment ${index} is not a valid file reference.`
      )
    }
  }
}

function assertThreadAcceptsRun(thread: AgentThreadRecord, principal: Principal): void {
  assertThreadAcceptsMessages(thread, principal)
  // Fast single-flight check for a clear error. `runs.create` is the atomic authority.
  if (thread.activeRunId !== null) {
    throw new AgentRequestError(
      "active_run_exists",
      `[Sixb] Agent thread '${thread.id}' already has an active run '${thread.activeRunId}'.`
    )
  }
}

/** Whether `principal` may send the thread a message: a turn may still be running. */
function assertThreadAcceptsMessages(thread: AgentThreadRecord, principal: Principal): void {
  assertConversationThread(thread)
  assertSandboxExecutionAvailable(thread)
  // Its owner's computer runs its turns as its owner: nobody else may send it one.
  if (thread.runsOn === "computer" && !principalsEqual(principal, thread.ownerPrincipal)) {
    throw new AgentRequestError(
      "not_thread_owner",
      `[Sixb] Agent thread '${thread.id}' runs on its owner's computer, as them: only its owner can message it. Shared with you, it is yours to read and follow.`
    )
  }
}

function assertSandboxExecutionAvailable(thread: AgentThreadRecord): void {
  if (
    thread.runsOn !== "computer" &&
    thread.sandboxState &&
    !["new", "ready"].includes(thread.sandboxState.status)
  ) {
    throw new AgentRequestError(
      "sandbox_execution_unavailable",
      "[Sixb] Sandbox recovery is required before another run. Reload the thread, then resume its previous sandbox or recreate it to start fresh."
    )
  }
}

async function assertAiLimitPreflight(
  runtime: SixbRuntimeContext,
  execution: Pick<ExecutionRecord, "requestedBy" | "requesterGroupIds">
): Promise<void> {
  const limits = runtime.storage.aiLimits
  if (!limits) throw aiUsageLimitUnavailableError(["limitStorageUnavailable"])

  const subjects = aiLimitSubjectsFromAttribution(
    execution.requestedBy,
    execution.requesterGroupIds
  )
  let applicable: readonly AiLimitPolicyStatus[]
  try {
    applicable = applicableAiLimitPolicyStatuses(
      await limits.listPolicyStatuses({ projectId: runtime.projectId }),
      subjects
    )
  } catch {
    throw aiUsageLimitUnavailableError(["limitStorageUnavailable"])
  }

  const unavailable = applicable.filter((status) => status.accountingStatus === "unavailable")
  if (unavailable.length > 0) {
    throw aiUsageLimitUnavailableError(["incompleteAccounting"])
  }
  const exhausted = applicable.filter((status) => status.exhausted)
  if (exhausted.length > 0) {
    const resetAt = new Date(
      Math.min(...exhausted.map((status) => status.period.resetAt.getTime()))
    )
    throw aiUsageLimitExceededError(resetAt)
  }
}

/**
 * Freeze the model selection of a turn. The model's default reasoning is resolved here, not by the
 * worker, so a retry runs with the reasoning the turn was admitted with.
 */
async function resolveConversationRunSpec(input: {
  readonly models?: LanguageModelCatalog
  readonly selection: Pick<RequestAgentRunInput, "model" | "reasoning">
  readonly settings: RequesterSettings
  /** The decision model's answer, when Sixb picked the model. */
  readonly tierProbabilities?: LanguageModelTierProbabilities
}): Promise<ConversationAgentRunSpec> {
  if (!input.models) {
    throw new AgentRequestError(
      "model_not_found",
      "[Sixb] Configure models.language before starting the Agent."
    )
  }
  const selected = input.selection.model ?? input.models.default
  const model = input.models.getByRef(selected)
  if (model === null) {
    throw new AgentRequestError(
      "model_not_found",
      `[Sixb] Language model '${selected.provider}/${selected.modelId}' is not in the project model catalog.`
    )
  }

  const explicitReasoning = input.selection.reasoning
  if (explicitReasoning !== undefined) {
    await assertModelSupportsReasoning(model, explicitReasoning)
  }
  const reasoning = explicitReasoning ?? model.model.defaultReasoning
  const { timeZone, locale } = input.settings

  return Object.freeze({
    model: Object.freeze({ provider: selected.provider, modelId: selected.modelId }),
    ...(model.tier === undefined ? {} : { tier: model.tier }),
    ...(input.tierProbabilities === undefined
      ? {}
      : { tierProbabilities: Object.freeze({ ...input.tierProbabilities }) }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  })
}

/** Canonical settings of the person asking, as the run spec stores them. */
type RequesterSettings = Pick<ConversationAgentRunSpec, "timeZone" | "locale">

function requesterSettings(
  input: Pick<RequestAgentRunInput, "timeZone" | "locale">
): RequesterSettings {
  const timeZone = requestedSetting(
    "timeZone",
    input.timeZone,
    canonicalTimeZone,
    "an IANA time zone"
  )
  const locale = requestedSetting("locale", input.locale, canonicalLocale, "a BCP 47 language tag")

  return {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(locale === undefined ? {} : { locale }),
  }
}

function requestedSetting(
  field: "timeZone" | "locale",
  value: string | undefined,
  canonical: (value: unknown) => string | undefined,
  expected: string
): string | undefined {
  if (value === undefined) return undefined
  const resolved = canonical(value)
  if (resolved === undefined) {
    throw new AgentRequestError(
      "invalid_locale",
      `[Sixb] Agent request '${field}' must be ${expected}; received ${JSON.stringify(value)}.`
    )
  }
  return resolved
}

// Checked against the model's resolved capabilities, as `GET /api/models` reports them (its
// configured ones when the provider catalog is unavailable). Undeclared capabilities accept any
// level; the provider then falls back to its own default.
async function assertModelSupportsReasoning(
  entry: LanguageModelEntry,
  reasoning: unknown
): Promise<void> {
  if (!isModelReasoning(reasoning)) {
    throw new AgentRequestError(
      "invalid_model_selection",
      `[Sixb] Agent reasoning must be one of: ${AGENT_REASONING_LEVELS.join(", ")}, or a nonnegative budgetTokens object.`
    )
  }
  if (reasoning === "provider-default") return
  const model = await resolveLanguageModel(entry.model)
  const issue = modelReasoningSupportIssue(model.definition.capabilities.reasoning, reasoning)
  if (issue !== undefined) {
    throw new AgentRequestError(
      "invalid_model_selection",
      `[Sixb] Language model '${entry.provider}/${entry.modelId}' cannot use this reasoning: ${issue}.`
    )
  }
}

async function prepareDurableAgentExecution(
  runtime: SixbRuntimeContext,
  execution: ExecutionContext,
  runId: string
): Promise<Omit<ExecutionRecord, "createdAt">> {
  const parent = await ensureExecutionRecord(
    runtime.storage.executions,
    executionRecordInputFromRuntime({
      execution,
      runtimeAuthorization: runtime.runtimeAuthorization,
    })
  )
  return createInheritedAgentExecutionRecord({
    id: `exec_${randomUUID()}`,
    parent,
    runId,
  })
}

function assertRequestAuthorityCanRunAgent(runtime: SixbRuntimeContext): void {
  if (!canInheritAgentRequestAuthorization(runtime.runtimeAuthorization)) {
    throw new AgentRequestError(
      "authority_not_inheritable",
      "[Sixb] The Agent requires an authenticated user request or disabled authorization."
    )
  }
}

export async function dispatchAgentRun(
  runtime: SixbRuntimeContext,
  agents: AgentStorage,
  runId: string
): Promise<string | undefined> {
  // The queued run is the durable dispatch intent. Publication is best-effort; workers reconcile
  // it with the same deterministic queue job id if the queue is temporarily unavailable.
  try {
    const dispatch = await dispatchQueuedAgentRuns({
      projectId: runtime.projectId,
      storage: agents,
      queue: runtime.queues.agents,
      runIds: [runId],
    })
    const failure = dispatch.failures[0]
    if (failure) {
      console.error(
        `[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`,
        failure.error
      )
    }
    return dispatch.dispatched[0]?.jobId
  } catch (error) {
    console.error(`[Sixb] Could not dispatch queued agent run '${runId}'; retrying later.`, error)
    return undefined
  }
}

/** Activity delivery is observational: durable run admission remains successful if the feed is down. */
async function publishRunActivity(
  runtime: SixbRuntimeContext,
  run: ConversationAgentRunRecord
): Promise<void> {
  try {
    await publishAgentRunActivity(runtime.broker, run)
  } catch (error) {
    console.error(`[Sixb] Agent run '${run.id}' activity stream publish failed:`, error)
  }
}

function createThread(
  agents: AgentStorage,
  params: {
    readonly projectId: string
    readonly threadId?: string
    readonly title?: string
    readonly principal: Principal
    readonly runsOn?: "computer"
    readonly computer?: AgentThreadComputer
  }
): Promise<AgentThreadRecord> {
  return agents.threads.create({
    id: params.threadId ?? createAgentThreadId(),
    projectId: params.projectId,
    ownerPrincipal: params.principal,
    ...(params.title === undefined ? {} : { title: params.title }),
    ...(params.runsOn === undefined ? {} : { runsOn: params.runsOn }),
    ...(params.computer === undefined ? {} : { computer: params.computer }),
  })
}

/** A thread runs on a computer exactly when it names the computer and the folder there. */
export function assertComputerPlaceRequest(runsOn: unknown, computer: unknown): void {
  if ((runsOn === "computer") !== (computer !== undefined)) {
    throw new AgentRequestError(
      "invalid_message",
      `[Sixb] A thread that runs on a computer names it and its folder: send 'runsOn: "computer"' with 'computer', or neither.`
    )
  }
}

function requireAgentStorage(runtime: SixbRuntimeContext): AgentStorage {
  const agents = runtime.storage.agents
  if (!agents) {
    throw new AgentRequestError("storage_unavailable", "[Sixb] Agent storage is not configured.")
  }
  return agents
}
