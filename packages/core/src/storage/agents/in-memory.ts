import { AGENT_MESSAGE_CONTENT_VERSION } from "../../agents/message"
import { type Principal, principalsEqual, type UserPrincipal } from "../../auth"
import { parseSixbFailure } from "../../errors/internal"
import type { SixbFailure } from "../../errors/types"
import type { ExecutionStorage } from "../executions"
import { AgentStorageError } from "./errors"
import {
  agentApprovalCallKey,
  agentApprovalClaimable,
  agentApprovalHoldsRun,
  agentApprovalMatches,
  agentApprovalRepairable,
  agentApprovalStops,
  agentContextCheckpointMatchesCreateInput,
  agentMemoryConflicts,
  agentMemoryHistoryCutoff,
  agentRunMayHoldCalls,
  assertAgentApprovalCaller,
  assertAgentApprovalModeInput,
  assertAgentBackgroundCommandRef,
  assertAgentComputerSession,
  assertAgentContextCheckpointAnchors,
  assertAgentContextCheckpointAuthority,
  assertAgentContextCheckpointReplayState,
  assertAgentRunExecution,
  assertAgentRunFinishPayload,
  assertAgentThreadComputer,
  assertAgentTokenRateRecord,
  assertAssignableComputer,
  assertAwaitingApprovalFinish,
  assertComputerPlace,
  assertConversationAgentRunSpec,
  assertConversationThreadRow,
  assertCreateAgentContextCheckpointInput,
  assertCreateSubagentRunInput,
  assertDeleteAgentContextCheckpointsAfterSeqInput,
  assertDeleteAgentMessagesFromSeqInput,
  assertEnqueueAgentInboxItemInput,
  assertInboxRunOwnership,
  assertInboxThreadAcceptsItem,
  assertMovableToCloud,
  assertRequestAgentApprovalInput,
  assertSaveAgentMemoryInput,
  assertSearchAgentTurnVectorsInput,
  assertStartsOnComputer,
  assertSubagentThreadTakesRun,
  assertTakeAgentInboxSteersInput,
  assertTurnInThreadPlace,
  assertUpdateAgentInboxItemInput,
  assertWriteAgentTurnVectorsInput,
  compareAgentMemoryPaths,
  compareAgentThreadParticipants,
  countsAsThreadMessage,
  isUnreadFor,
  LIVE_AGENT_APPROVAL_STATUSES,
  movesComputerPlace,
  newAgentApprovalRecord,
  newAgentInboxItemRecord,
  newSubagentThreadRecord,
  participantsToAdd,
  planAgentThreadFork,
  queuedTurnInCloud,
  queuedTurnOnComputer,
  remapArtifactIds,
  snapshotAgentThreadSandboxParams,
  subagentRunMatchesCreateInput,
  transitionAgentThreadSandbox,
  unavailableChildSandboxState,
  updatedAgentInboxItemRecord,
  withStopRequest,
} from "./provider"
import type {
  AddAgentThreadParticipantsInput,
  AgentApprovalCursor,
  AgentApprovalMode,
  AgentApprovalModeStore,
  AgentApprovalOutcome,
  AgentApprovalRecord,
  AgentApprovalStore,
  AgentBackgroundCommandRef,
  AgentComputerSessionRecord,
  AgentComputerSessionStore,
  AgentContextCheckpointRecord,
  AgentContextCheckpointStore,
  AgentInboxItemRecord,
  AgentInboxStore,
  AgentMemoryChange,
  AgentMemoryRepoRecord,
  AgentMemoryRevisionRecord,
  AgentMemoryStore,
  AgentMessageRecord,
  AgentMessageStore,
  AgentRunFailureCode,
  AgentRunRecord,
  AgentRunStore,
  AgentStorage,
  AgentThreadIndexProgress,
  AgentThreadParticipantRecord,
  AgentThreadReadRecord,
  AgentThreadReadState,
  AgentThreadReadStore,
  AgentThreadRecord,
  AgentThreadSandboxState,
  AgentThreadStore,
  AgentThreadToIndex,
  AgentTokenRateRecord,
  AgentTokenRateStore,
  AgentTurnSearchHit,
  AgentTurnVectorRecord,
  AgentTurnVectorStore,
  AppendAgentMessageInput,
  AssignAgentThreadComputerInput,
  ConfirmAgentRunExecutionOwnershipInput,
  ConsumeClaimedAgentInboxInput,
  ConversationAgentRunRecord,
  CreateAgentContextCheckpointInput,
  CreateAgentRunInput,
  CreateAgentThreadInput,
  CreateSubagentRunInput,
  DecideAgentApprovalInput,
  DecideAgentApprovalResult,
  DeferAgentThreadIndexingInput,
  DeleteAgentContextCheckpointsAfterSeqInput,
  DeleteAgentMessagesByRunInput,
  DeleteAgentMessagesFromSeqInput,
  EnqueueAgentInboxItemInput,
  EnqueueAgentInboxItemResult,
  FinishAgentRunInput,
  FinishQueuedAgentRunInput,
  ForkAgentThreadInput,
  GetAgentThreadIndexProgressInput,
  HaltAgentThreadIndexingInput,
  ListAgentApprovalsInput,
  ListAgentApprovalsResult,
  ListAgentInboxItemsInput,
  ListAgentMemoryRevisionsInput,
  ListAgentMemoryRevisionsResult,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadChildrenInput,
  ListAgentThreadIdsByArtifactContextInput,
  ListAgentThreadParticipantsInput,
  ListAgentThreadReadsInput,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ListAgentThreadsToIndexInput,
  ListAgentTurnVectorsInput,
  ListLatestAgentRunsInput,
  ListThreadSubagentsInput,
  ListWaitingAgentInboxThreadsInput,
  MarkAgentApprovalsReportedInput,
  MarkAgentThreadReadInput,
  MoveAgentThreadToCloudInput,
  MoveAgentThreadToCloudResult,
  ReclaimAgentRunInput,
  RemoveAgentInboxItemInput,
  RemoveAgentThreadParticipantInput,
  RequestAgentApprovalInput,
  RequestAgentApprovalResult,
  RequestAgentRunCancelInput,
  RewindAgentApprovalsInput,
  RewindAgentApprovalsResult,
  SaveAgentMemoryInput,
  SaveAgentMemoryResult,
  SearchAgentTurnVectorsInput,
  SearchAgentTurnVectorsResult,
  SettleAgentApprovalsInput,
  StartAgentRunInput,
  StopAgentApprovalsInput,
  StopAgentApprovalsResult,
  SubagentRunRecord,
  TakeAgentInboxSteersInput,
  TakeNextQueuedAgentInboxInput,
  TransitionAgentThreadSandboxInput,
  UpdateAgentInboxItemInput,
  WriteAgentTurnVectorsInput,
} from "./types"
import { AGENT_RUN_FAILURE_CODES, AGENT_TOKEN_RATE_SAMPLES } from "./types"

function normalizeFailure(
  failure: SixbFailure<AgentRunFailureCode> | undefined
): SixbFailure<AgentRunFailureCode> | undefined {
  return failure ? parseSixbFailure(failure, AGENT_RUN_FAILURE_CODES) : undefined
}

function key(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
}

function readKey(projectId: string, threadId: string, principal: UserPrincipal): string {
  return JSON.stringify([projectId, threadId, principal.id])
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function compareByDate(
  left: Date | undefined,
  right: Date | undefined,
  leftId: string,
  rightId: string,
  order: "asc" | "desc"
): number {
  const delta = (left?.getTime() ?? 0) - (right?.getTime() ?? 0)
  if (delta !== 0) {
    return order === "asc" ? delta : -delta
  }
  if (leftId === rightId) {
    return 0
  }
  return order === "asc" ? leftId.localeCompare(rightId) : rightId.localeCompare(leftId)
}

interface Window<T> {
  readonly page: T[]
  readonly hasMore: boolean
  readonly total: number
}

function applyWindow<T>(rows: T[], offset = 0, limit?: number): Window<T> {
  const total = rows.length
  const end = limit === undefined ? total : offset + limit
  const page = rows.slice(offset, end)
  return { page, hasMore: offset + page.length < total, total }
}

/**
 * Shared in-memory state behind the sub-stores. They are tiered for ergonomics
 * (`storage.runs.create(...)`), but several operations span tables — creating/finishing a run
 * updates the thread anchor, appending a message bumps thread stats, and checkpoint creation reads
 * run/thread/message anchors — so they all read and write the same maps through this object.
 */
interface AgentStoreState {
  readonly threads: Map<string, AgentThreadRecord>
  /** By thread key; each thread's participants in the order they were added. */
  readonly participants: Map<string, AgentThreadParticipantRecord[]>
  /** By `[projectId, threadId, principalId]`. */
  readonly reads: Map<string, AgentThreadReadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
  readonly memory: Map<string, StoredAgentMemoryRepo>
  readonly approvals: Map<string, AgentApprovalRecord>
  /** By `[projectId, principal]` for a default, `[projectId, threadId, principal]` for a thread. */
  readonly approvalModes: Map<string, AgentApprovalMode>
  /** By `[projectId, runId]`. */
  readonly tokenRates: Map<string, AgentTokenRateRecord>
  /** By `[projectId, id]`. */
  readonly inbox: Map<string, AgentInboxItemRecord>
  /**
   * By thread key: what `agent_threads.message_revision` holds, bumped by every message added or
   * taken. A thread without an entry is at 0.
   */
  readonly messageRevisions: Map<string, number>
  /** By `[projectId, messageId, chunk]`. */
  readonly turnVectors: Map<string, AgentTurnVectorRecord>
  /** By thread key. */
  readonly threadIndexes: Map<string, StoredAgentThreadIndex>
}

/** A row of `agent_thread_index_state`: how far a conversation's turns are indexed. */
interface StoredAgentThreadIndex {
  readonly configuration: string
  /**
   * The revision indexed whole, `agent_threads.indexed_revision` in SQL; null while indexing is
   * part way, or before it wrote.
   */
  readonly revision: number | null
  /** The first message a deletion took since, whose turn indexing goes back to. */
  readonly staleFromSeq: number | null
  readonly deferredUntil: Date | null
  readonly failures: number
  /** The message revision indexing failed at for good, under `configuration`. */
  readonly haltedRevision: number | null
  /** Null until indexing first wrote. */
  readonly indexedAt: Date | null
}

/** A memory repo as its two SQL tables hold it: revisions, and the file versions each wrote. */
interface StoredAgentMemoryRepo {
  /** Oldest first. */
  readonly revisions: readonly Omit<AgentMemoryRevisionRecord, "changes">[]
  /** In insertion order, so by revision. `contents: null` deleted the path. */
  readonly files: readonly (AgentMemoryChange & { readonly revision: number })[]
}

export interface InMemoryAgentStorageSnapshot {
  readonly threads: Map<string, AgentThreadRecord>
  readonly participants: Map<string, AgentThreadParticipantRecord[]>
  readonly reads: Map<string, AgentThreadReadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
  readonly memory: Map<string, StoredAgentMemoryRepo>
  readonly approvals: Map<string, AgentApprovalRecord>
  readonly approvalModes: Map<string, AgentApprovalMode>
  readonly tokenRates: Map<string, AgentTokenRateRecord>
  readonly inbox: Map<string, AgentInboxItemRecord>
  readonly messageRevisions: Map<string, number>
  readonly turnVectors: Map<string, AgentTurnVectorRecord>
  readonly threadIndexes: Map<string, StoredAgentThreadIndex>
}

// ── threads ───────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentThreadStore implements AgentThreadStore {
  constructor(private readonly state: AgentStoreState) {}

  async transitionSandbox(
    input: TransitionAgentThreadSandboxInput
  ): Promise<AgentThreadSandboxState> {
    const threadKey = key(input.projectId, input.id)
    const thread = this.state.threads.get(threadKey) ?? null
    const run =
      input.action === "recreate" || input.action === "restore"
        ? null
        : (this.state.runs.get(key(input.projectId, input.runId)) ?? null)
    const sandboxState = transitionAgentThreadSandbox(thread, run, input)
    if (!thread) throw new AgentStorageError("thread_not_found", "[Sixb] Thread not found.")
    this.state.threads.set(threadKey, { ...thread, sandboxState: clone(sandboxState) })
    return clone(sandboxState)
  }

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
    assertComputerPlace(input.runsOn, input.computer)
    const sandboxParams =
      input.sandboxParams === undefined
        ? undefined
        : snapshotAgentThreadSandboxParams(input.sandboxParams)
    const threadKey = key(input.projectId, input.id)
    if (this.state.threads.has(threadKey)) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const createdAt = new Date(input.createdAt ?? new Date())
    const record: AgentThreadRecord = {
      id: input.id,
      projectId: input.projectId,
      kind: "conversation",
      ownerPrincipal: clone(input.ownerPrincipal),
      ...(sandboxParams === undefined ? {} : { sandboxParams }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.runsOn === undefined ? {} : { runsOn: input.runsOn }),
      ...(input.computer === undefined ? {} : { computer: clone(input.computer) }),
      status: input.status ?? "active",
      activeRunId: null,
      messageCount: 0,
      createdAt,
      updatedAt: new Date(input.updatedAt ?? createdAt),
    }

    this.state.threads.set(threadKey, clone(record))
    return clone(record)
  }

  async fork(input: ForkAgentThreadInput): Promise<AgentThreadRecord> {
    // No `await` between reading the source and writing the fork: one in-memory critical section.
    const source = this.state.threads.get(key(input.projectId, input.sourceThreadId))
    if (!source) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.sourceThreadId}' not found for project '${input.projectId}'.`
      )
    }
    assertConversationThreadRow(source, "can be forked")

    const forkKey = key(input.projectId, input.id)
    if (this.state.threads.has(forkKey)) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent thread '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const activeRun =
      source.activeRunId === null
        ? undefined
        : this.state.runs.get(key(input.projectId, source.activeRunId))

    const messages = [...this.state.messages.values()]
      .filter((message) => message.projectId === input.projectId)
      .filter((message) => message.threadId === source.id)
      .sort((left, right) => left.seq - right.seq)

    const checkpoints = [...this.state.checkpoints.values()]
      .filter((checkpoint) => checkpoint.projectId === input.projectId)
      .filter((checkpoint) => checkpoint.threadId === source.id)
      .sort(compareLatestCheckpoints)

    const plan = planAgentThreadFork(input, {
      workspace: source,
      ...(activeRun?.kind === "conversation"
        ? { triggerMessageId: activeRun.triggerMessageId }
        : {}),
      messages: messages.map((message) => ({
        ...message,
        counted: countsAsThreadMessage(message),
      })),
      checkpoints,
    })

    this.state.threads.set(forkKey, clone(plan.thread))

    const copyIds = new Map(plan.messages.map((copy) => [copy.sourceId, copy.id]))
    for (const message of messages) {
      const id = copyIds.get(message.id)
      if (id === undefined) continue

      const parts = JSON.parse(
        remapArtifactIds(JSON.stringify(message.parts), input.artifactCopies)
      ) as AgentMessageRecord["parts"]
      this.state.messages.set(
        key(input.projectId, id),
        clone({ ...message, id, threadId: input.id, parts })
      )
    }

    if (plan.checkpoint) {
      this.state.checkpoints.set(key(input.projectId, plan.checkpoint.id), clone(plan.checkpoint))
    }

    // The owner of the copy keeps their place: copied messages keep their seq, so what they had
    // not read in the source is what they have not read here. Only a user reads.
    const sourceRead =
      input.ownerPrincipal.type === "user"
        ? this.state.reads.get(readKey(input.projectId, input.sourceThreadId, input.ownerPrincipal))
        : undefined
    if (sourceRead && input.ownerPrincipal.type === "user") {
      this.state.reads.set(readKey(input.projectId, input.id, input.ownerPrincipal), {
        ...sourceRead,
        threadId: input.id,
        throughSeq: Math.min(sourceRead.throughSeq, plan.headSeq),
      })
    }
    copyTurnVectors(this.state, input, copyIds)

    return clone(plan.thread)
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null> {
    const record = this.state.threads.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly AgentThreadRecord[]> {
    return [...new Set(params.ids)].flatMap((id) => {
      const record = this.state.threads.get(key(params.projectId, id))
      return record ? [clone(record)] : []
    })
  }

  async listChildren(input: ListAgentThreadChildrenInput): Promise<readonly AgentThreadRecord[]> {
    const offset = input.offset ?? 0
    return [...this.state.threads.values()]
      .filter((thread) => thread.projectId === input.projectId)
      .filter((thread) => thread.parent?.threadId === input.parentThreadId)
      .filter((thread) =>
        input.parentRunId === undefined ? true : thread.parent?.spawnedBy === input.parentRunId
      )
      .sort((a, b) => compareByDate(a.createdAt, b.createdAt, a.id, b.id, "asc"))
      .slice(offset, offset + (input.limit ?? 100))
      .map(clone)
  }

  async list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult> {
    const order = input.order ?? "desc"
    const statuses = input.statuses ? new Set(input.statuses) : null
    const filtered = [...this.state.threads.values()]
      .filter((thread) => thread.projectId === input.projectId)
      .filter((thread) => thread.kind === "conversation")
      .filter((thread) => (statuses ? statuses.has(thread.status) : true))
      .filter((thread) =>
        input.ownerPrincipal ? principalsEqual(thread.ownerPrincipal, input.ownerPrincipal) : true
      )
      .filter((thread) => {
        const on = input.activeOnComputer
        if (!on) return true
        return (
          thread.activeRunId !== null &&
          thread.computer?.id === on.id &&
          thread.computer.folder === on.folder
        )
      })
      .filter((thread) => {
        const participant = input.participantPrincipal
        if (!participant) return true

        return this.participantsOf(thread.projectId, thread.id).some(
          (record) => record.principal.id === participant.id
        )
      })
      .sort((a, b) =>
        compareByDate(
          a.lastMessageAt ?? a.createdAt,
          b.lastMessageAt ?? b.createdAt,
          a.id,
          b.id,
          order
        )
      )

    const { page, hasMore, total } = applyWindow(filtered, input.offset, input.limit)
    return { threads: page.map(clone), hasMore, total }
  }

  async addParticipants(
    input: AddAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    const threadKey = key(input.projectId, input.threadId)
    const thread = this.state.threads.get(threadKey)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }
    assertConversationThreadRow(thread, "has participants")

    // No `await` from here on: the read and the write are one critical section.
    const existing = this.participantsOf(input.projectId, input.threadId)
    const addedAt = new Date(input.addedAt ?? new Date())
    const added = participantsToAdd(input, existing).map((principal) => ({
      projectId: input.projectId,
      threadId: input.threadId,
      principal,
      addedAt: new Date(addedAt),
      addedBy: clone(input.addedBy),
    }))

    const participants = [...existing, ...added].sort(compareAgentThreadParticipants)
    this.state.participants.set(threadKey, participants)
    // Someone who joins starts caught up: what came before is not new to them. A place left
    // from an earlier stay, or written by a mark that raced the removal, does not carry over.
    const headSeq = headSeqOf(this.state, input.projectId, input.threadId)
    for (const participant of added) {
      this.state.reads.set(readKey(input.projectId, input.threadId, participant.principal), {
        projectId: input.projectId,
        threadId: input.threadId,
        principal: clone(participant.principal),
        throughSeq: headSeq,
        readAt: new Date(addedAt),
      })
    }
    return clone(participants)
  }

  async removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean> {
    const threadKey = key(input.projectId, input.threadId)
    const existing = this.state.participants.get(threadKey)
    const kept = existing?.filter((record) => record.principal.id !== input.principal.id)
    if (!existing || !kept || kept.length === existing.length) return false

    this.state.participants.set(threadKey, kept)
    this.state.reads.delete(readKey(input.projectId, input.threadId, input.principal))
    return true
  }

  async assignComputer(input: AssignAgentThreadComputerInput): Promise<AgentThreadRecord> {
    assertAgentThreadComputer(input.computer)
    const threadKey = key(input.projectId, input.id)
    const thread = this.state.threads.get(threadKey) ?? null
    const active = thread?.activeRunId
      ? (this.state.runs.get(key(input.projectId, thread.activeRunId)) ?? null)
      : null
    assertAssignableComputer(thread, active, input.computer, input.id)

    const queued = queuedTurnOnComputer(active, input.computer)
    if (queued) this.state.runs.set(key(input.projectId, queued.id), queued)
    if (thread.runsOn !== "computer") {
      for (const [childKey, child] of this.state.threads) {
        if (child.projectId !== input.projectId || child.parent?.threadId !== input.id) continue
        const nextState = unavailableChildSandboxState(child.sandboxState)
        if (nextState) this.state.threads.set(childKey, { ...child, sandboxState: nextState })
      }
    }
    const assigned: AgentThreadRecord = {
      ...thread,
      runsOn: "computer",
      computer: clone(input.computer),
      ...(movesComputerPlace(thread, input.computer)
        ? { movedAt: new Date(input.movedAt ?? new Date()) }
        : {}),
    }
    this.state.threads.set(threadKey, assigned)
    return clone(assigned)
  }

  async moveToCloud(input: MoveAgentThreadToCloudInput): Promise<MoveAgentThreadToCloudResult> {
    const threadKey = key(input.projectId, input.id)
    const thread = this.state.threads.get(threadKey) ?? null
    const active = thread?.activeRunId
      ? (this.state.runs.get(key(input.projectId, thread.activeRunId)) ?? null)
      : null
    assertMovableToCloud(thread, active, input.id)

    const queued = queuedTurnInCloud(active)
    if (queued) this.state.runs.set(key(input.projectId, queued.id), queued)
    const { runsOn: _runsOn, computer: _computer, ...rest } = thread
    const moved: AgentThreadRecord = { ...rest, movedAt: new Date(input.movedAt ?? new Date()) }
    this.state.threads.set(threadKey, moved)
    return { thread: clone(moved), ...(queued ? { queued: clone(queued) } : {}) }
  }

  async listParticipants(
    input: ListAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]> {
    return [...new Set(input.threadIds)]
      .flatMap((threadId) => clone(this.participantsOf(input.projectId, threadId)))
      .sort(compareAgentThreadParticipants)
  }

  private participantsOf(projectId: string, threadId: string): AgentThreadParticipantRecord[] {
    return this.state.participants.get(key(projectId, threadId)) ?? []
  }
}

// ── reads ────────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentThreadReadStore implements AgentThreadReadStore {
  constructor(private readonly state: AgentStoreState) {}

  async mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadState> {
    const thread = this.state.threads.get(key(input.projectId, input.threadId))
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    const reached = this.reachedSeq(input)
    if (reached === null) return this.stateOf(thread, input.principal)

    const storedKey = readKey(input.projectId, input.threadId, input.principal)
    const known = this.state.reads.get(storedKey)
    const readAt = new Date(input.readAt ?? new Date())

    // Never backwards: another device that read further keeps its place. Looking always counts.
    this.state.reads.set(storedKey, {
      projectId: input.projectId,
      threadId: input.threadId,
      principal: clone(input.principal),
      throughSeq: Math.max(known?.throughSeq ?? 0, reached),
      readAt: known && known.readAt > readAt ? known.readAt : readAt,
    })

    return this.stateOf(thread, input.principal)
  }

  async list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadState[]> {
    return [...new Set(input.threadIds)]
      .map((threadId) => this.state.threads.get(key(input.projectId, threadId)))
      .filter((thread): thread is AgentThreadRecord => thread !== undefined)
      .map((thread) => this.stateOf(thread, input.principal))
  }

  /** The seq a mark reaches: its message's, or the newest. `null` when the message is gone. */
  private reachedSeq(input: MarkAgentThreadReadInput): number | null {
    if (input.throughMessageId === undefined) {
      return headSeqOf(this.state, input.projectId, input.threadId)
    }

    const message = this.state.messages.get(key(input.projectId, input.throughMessageId))
    return message?.threadId === input.threadId ? message.seq : null
  }

  private stateOf(thread: AgentThreadRecord, reader: UserPrincipal): AgentThreadReadState {
    const read = this.state.reads.get(readKey(thread.projectId, thread.id, reader))
    const headSeq = headSeqOf(this.state, thread.projectId, thread.id)
    const throughSeq = Math.min(read?.throughSeq ?? 0, headSeq)

    let unread = 0
    for (const message of this.state.messages.values()) {
      if (message.projectId !== thread.projectId || message.threadId !== thread.id) continue
      if (message.seq > throughSeq && isUnreadFor(message, reader)) unread += 1
    }

    return {
      threadId: thread.id,
      throughSeq,
      headSeq,
      unread,
      ...(read === undefined ? {} : { readAt: new Date(read.readAt) }),
    }
  }
}

// ── runs ──────────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentRunStore implements AgentRunStore {
  constructor(
    private readonly state: AgentStoreState,
    private readonly executions: ExecutionStorage
  ) {}

  async create(input: CreateAgentRunInput): Promise<ConversationAgentRunRecord> {
    assertConversationAgentRunSpec(input.spec)
    await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
    })
    // No `await` between read and write: the in-memory critical section is atomic, so two concurrent
    // queued runs on the same thread cannot both win — the second observes `activeRunId` set.
    const threadKey = key(input.projectId, input.threadId)
    const thread = this.state.threads.get(threadKey)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }
    assertConversationThreadRow(thread, "takes turns")
    if (thread.activeRunId !== null) {
      throw new AgentStorageError(
        "active_run_exists",
        `[Sixb] Agent thread '${input.threadId}' already has an active run '${thread.activeRunId}'.`
      )
    }
    assertTurnInThreadPlace(thread.runsOn, input.spec, input.threadId)

    const runKey = key(input.projectId, input.id)
    if (this.state.runs.has(runKey)) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent run '${input.id}' already exists for project '${input.projectId}'.`
      )
    }
    if (
      [...this.state.runs.values()].some(
        (run) => run.projectId === input.projectId && run.executionId === input.executionId
      )
    ) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Execution '${input.executionId}' already belongs to another Agent run.`
      )
    }

    const createdAt = new Date(input.createdAt ?? new Date())
    const run: ConversationAgentRunRecord = {
      kind: "conversation",
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      threadId: input.threadId,
      triggerMessageId: input.triggerMessageId,
      spec: clone(input.spec),
      status: "queued",
      attempt: 0,
      createdAt,
    }
    this.state.runs.set(runKey, clone(run))

    const updatedThread: AgentThreadRecord = {
      ...thread,
      activeRunId: run.id,
      updatedAt: createdAt,
    }
    this.state.threads.set(threadKey, clone(updatedThread))

    return clone(run)
  }

  async createSubagent(input: CreateSubagentRunInput): Promise<SubagentRunRecord> {
    assertCreateSubagentRunInput(input)
    const execution = await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
    })

    const runKey = key(input.projectId, input.id)
    const existing = this.state.runs.get(runKey)
    if (existing) {
      if (subagentRunMatchesCreateInput(existing, input)) return clone(existing)
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Subagent run '${input.id}' already exists with different immutable inputs.`
      )
    }

    const parent = this.state.runs.get(key(input.projectId, input.parentRunId))
    if (!parent || parent.kind !== "conversation") {
      throw new AgentStorageError(
        "run_not_found",
        `[Sixb] Parent Agent run '${input.parentRunId}' was not found.`
      )
    }
    if (parent.status !== "running") {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Parent Agent run '${parent.id}' is not running (status '${parent.status}').`
      )
    }
    if (
      execution.source.type !== "execution" ||
      execution.source.executionId !== parent.executionId
    ) {
      throw new AgentStorageError(
        "invalid_input",
        `[Sixb] Subagent execution '${execution.id}' is not a child of parent execution '${parent.executionId}'.`
      )
    }
    if (parent.execution?.token !== input.parentExecutionToken) {
      throw new AgentStorageError(
        "execution_lost",
        `[Sixb] Parent Agent run '${parent.id}' is no longer owned by this execution.`
      )
    }
    const activeChildren = [...this.state.runs.values()].filter(
      (run) =>
        run.kind === "subagent" &&
        run.projectId === input.projectId &&
        run.parentRunId === parent.id &&
        (run.status === "queued" || run.status === "running")
    ).length
    if (activeChildren >= input.maxActiveChildren) {
      throw new AgentStorageError(
        "active_child_limit",
        `[Sixb] Agent run '${parent.id}' already has ${activeChildren} active subagents.`
      )
    }
    if (
      [...this.state.runs.values()].some(
        (run) => run.projectId === input.projectId && run.executionId === input.executionId
      )
    ) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Execution '${input.executionId}' already belongs to another Agent run.`
      )
    }

    // The child's thread: created by its first run, taken by a later one while it is idle.
    const createdAt = new Date(input.createdAt ?? new Date())
    const threadKey = key(input.projectId, input.thread.id)
    const existingThread = this.state.threads.get(threadKey) ?? null
    let thread: AgentThreadRecord
    if (input.thread.create) {
      if (existingThread) {
        throw new AgentStorageError(
          "duplicate_id",
          `[Sixb] Agent thread '${input.thread.id}' already exists for project '${input.projectId}'.`
        )
      }
      const conversation = this.state.threads.get(key(input.projectId, parent.threadId))
      if (!conversation) {
        throw new AgentStorageError(
          "thread_not_found",
          `[Sixb] Agent thread '${parent.threadId}' not found for project '${input.projectId}'.`
        )
      }
      thread = newSubagentThreadRecord(input, conversation, createdAt)
    } else {
      assertSubagentThreadTakesRun(existingThread, input, parent.threadId)
      thread = {
        ...existingThread,
        activeRunId: input.id,
        messageCount: existingThread.messageCount + 1,
        lastMessageAt: createdAt,
        updatedAt: createdAt,
      }
    }

    const run: SubagentRunRecord = {
      kind: "subagent",
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      threadId: input.thread.id,
      triggerMessageId: input.trigger.id,
      parentRunId: input.parentRunId,
      spawnKey: input.spawnKey,
      spec: clone(input.spec),
      status: "queued",
      attempt: 0,
      createdAt,
    }
    const trigger: AgentMessageRecord = {
      id: input.trigger.id,
      projectId: input.projectId,
      threadId: input.thread.id,
      runId: input.id,
      role: "user",
      seq: nextMessageSeq(this.state, input.projectId, input.thread.id),
      parts: clone(input.trigger.parts),
      ...(input.trigger.metadata === undefined ? {} : { metadata: clone(input.trigger.metadata) }),
      contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
      createdAt,
    }
    if (this.state.messages.has(key(input.projectId, trigger.id))) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent message '${trigger.id}' already exists for project '${input.projectId}'.`
      )
    }

    this.state.threads.set(threadKey, clone(thread))
    this.state.messages.set(key(input.projectId, trigger.id), clone(trigger))
    bumpMessageRevision(this.state, input.projectId, input.thread.id)
    this.state.runs.set(runKey, clone(run))
    return clone(run)
  }

  async start(input: StartAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireStatus(input.projectId, input.id, "queued")
    if (input.onComputer) {
      const thread = this.state.threads.get(key(input.projectId, run.threadId))
      assertStartsOnComputer(run, thread?.computer, input.onComputer)
    }
    const startedAt = new Date(input.startedAt ?? new Date())
    const next: AgentRunRecord = {
      ...run,
      status: "running",
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      attempt: 1,
      execution: clone(input.execution),
      startedAt,
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async finishQueued(input: FinishQueuedAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireStatus(input.projectId, input.id, "queued")
    const completedAt = new Date(input.completedAt ?? new Date())
    const next: AgentRunRecord = {
      ...run,
      status: input.status,
      ...(input.error === undefined ? {} : { error: normalizeFailure(input.error) }),
      completedAt,
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    this.releaseThread(run, completedAt)
    return clone(next)
  }

  async reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (
      input.ifLapsedBy &&
      run.execution &&
      run.execution.queueLeaseExpiresAt.getTime() > input.ifLapsedBy.getTime()
    ) {
      throw leaseStillHeld(input.id)
    }
    const next: AgentRunRecord = {
      ...run,
      attempt: run.attempt + 1,
      execution: clone(input.execution),
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async confirmExecutionOwnership(
    input: ConfirmAgentRunExecutionOwnershipInput
  ): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (!run.execution || run.execution.token !== input.executionToken) {
      throw new AgentStorageError(
        "execution_lost",
        `[Sixb] Execution token is no longer current on agent run '${input.id}'.`
      )
    }

    const next: AgentRunRecord = {
      ...run,
      execution: {
        ...run.execution,
        queueLeaseExpiresAt: new Date(
          Math.max(run.execution.queueLeaseExpiresAt.getTime(), input.queueLeaseExpiresAt.getTime())
        ),
      },
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async requestCancel(input: RequestAgentRunCancelInput): Promise<AgentRunRecord> {
    const run = this.state.runs.get(key(input.projectId, input.id))
    if (!run) {
      throw new AgentStorageError("run_not_found", `[Sixb] Agent run '${input.id}' was not found.`)
    }
    if (run.status !== "running" || run.cancelRequestedAt) return clone(run)
    const next: AgentRunRecord = { ...run, cancelRequestedAt: input.at ?? new Date() }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async finish(input: FinishAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (!run.execution || run.execution.token !== input.executionToken) {
      throw new AgentStorageError(
        "execution_lost",
        `[Sixb] Execution token is no longer current on agent run '${input.id}'.`
      )
    }
    assertAgentRunFinishPayload(run.kind, input, run.id, "Sixb")
    if (input.finishReason === "awaiting_approval") {
      assertAwaitingApprovalFinish({
        runId: run.id,
        status: input.status,
        holdsApproval: holdsRun(this.state, run.projectId, run.id),
      })
    }

    const completedAt = new Date(input.completedAt ?? new Date())
    const next: AgentRunRecord = {
      ...run,
      status: input.status,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
      ...(input.diagnostics === undefined ? {} : { diagnostics: clone(input.diagnostics) }),
      ...(input.status === "succeeded" && input.result !== undefined
        ? { result: clone(input.result) }
        : {}),
      ...(input.status === "succeeded" || input.error === undefined
        ? {}
        : { error: normalizeFailure(input.error) }),
      execution: undefined,
      completedAt,
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))

    this.releaseThread(run, completedAt)
    this.settleApprovals(run, input, completedAt)

    return clone(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null> {
    const record = this.state.runs.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async getByIds(params: {
    projectId: string
    ids: readonly string[]
  }): Promise<readonly AgentRunRecord[]> {
    return [...new Set(params.ids)]
      .map((id) => this.state.runs.get(key(params.projectId, id)))
      .filter((record): record is AgentRunRecord => record !== undefined)
      .map(clone)
  }

  async listThreadSubagents(
    input: ListThreadSubagentsInput
  ): Promise<readonly SubagentRunRecord[]> {
    const runs = [...this.state.runs.values()].filter((run) => run.projectId === input.projectId)
    const turns = new Map(
      runs.flatMap((run) => {
        if (run.kind !== "conversation" || run.threadId !== input.threadId) return []
        if (
          input.retainedTurnsOnly &&
          this.state.messages.get(key(run.projectId, run.triggerMessageId))?.threadId !==
            run.threadId
        ) {
          return []
        }
        return [[run.id, run]]
      })
    )
    const children = runs
      .filter((run): run is SubagentRunRecord => run.kind === "subagent")
      .filter((run) => turns.has(run.parentRunId))
      .filter((run) => (input.spawnKey === undefined ? true : run.spawnKey === input.spawnKey))
      .filter((run) =>
        input.finishReason === undefined ? true : run.finishReason === input.finishReason
      )
      .sort((left, right) => {
        const [a, b] = [turns.get(left.parentRunId), turns.get(right.parentRunId)]
        return (
          compareByDate(
            a?.startedAt ?? a?.createdAt,
            b?.startedAt ?? b?.createdAt,
            left.parentRunId,
            right.parentRunId,
            "desc"
          ) || compareByDate(left.createdAt, right.createdAt, left.id, right.id, "desc")
        )
      })
    return children.slice(0, input.limit ?? 100).map(clone)
  }

  async latestByThread(input: ListLatestAgentRunsInput): Promise<readonly AgentRunRecord[]> {
    const wanted = new Set(input.threadIds)
    const latest = new Map<string, AgentRunRecord>()
    for (const run of this.state.runs.values()) {
      if (run.projectId !== input.projectId || !wanted.has(run.threadId)) continue
      const known = latest.get(run.threadId)
      if (!known || compareByDate(run.createdAt, known.createdAt, run.id, known.id, "desc") < 0) {
        latest.set(run.threadId, run)
      }
    }
    return [...latest.values()].map(clone)
  }

  async list(input: ListAgentRunsInput): Promise<ListAgentRunsResult> {
    const order = input.order ?? "desc"
    const statuses = input.statuses ? new Set(input.statuses) : null
    const kinds = input.kinds ? new Set(input.kinds) : null

    const filtered = [...this.state.runs.values()]
      .filter((run) => run.projectId === input.projectId)
      .filter((run) => (kinds ? kinds.has(run.kind) : true))
      .filter((run) => (input.threadId ? run.threadId === input.threadId : true))
      .filter((run) =>
        input.parentRunId ? run.kind === "subagent" && run.parentRunId === input.parentRunId : true
      )
      .filter((run) => (statuses ? statuses.has(run.status) : true))
      .filter(
        (run) =>
          !input.excludeComputerTurns ||
          run.kind !== "conversation" ||
          run.spec?.runsOn !== "computer"
      )
      .filter((run) =>
        input.startedAfter ? (run.startedAt ?? run.createdAt) >= input.startedAfter : true
      )
      .filter((run) =>
        input.startedBefore ? (run.startedAt ?? run.createdAt) <= input.startedBefore : true
      )
      .sort((a, b) =>
        compareByDate(a.startedAt ?? a.createdAt, b.startedAt ?? b.createdAt, a.id, b.id, order)
      )

    const { page, hasMore, total } = applyWindow(filtered, input.offset, input.limit)
    return { runs: page.map(clone), hasMore, total }
  }

  private requireRunning(projectId: string, id: string): AgentRunRecord {
    return this.requireStatus(projectId, id, "running")
  }

  private requireStatus(
    projectId: string,
    id: string,
    status: AgentRunRecord["status"]
  ): AgentRunRecord {
    const run = this.state.runs.get(key(projectId, id))
    if (!run) {
      throw new AgentStorageError(
        "run_not_found",
        `[Sixb] Agent run '${id}' not found for project '${projectId}'.`
      )
    }
    if (run.status !== status) {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent run '${id}' is not ${status} (status '${run.status}').`
      )
    }
    return run
  }

  /**
   * A turn that pauses keeps its calls for their decision. A turn that ends any other way cancels
   * the ones still waiting, a late one included, and never resumes on the rest. A child that fails
   * or is cancelled takes its own pending calls with it.
   */
  private settleApprovals(run: AgentRunRecord, input: FinishAgentRunInput, at: Date): void {
    if (input.finishReason === "awaiting_approval" || !agentRunMayHoldCalls(run)) return

    const turn = run.kind === "conversation"
    if (!turn && input.status === "succeeded") return
    for (const [approvalKey, approval] of this.state.approvals) {
      if (approval.projectId !== run.projectId) continue
      const ownCall = approval.runId === run.id || approval.callerRunId === run.id
      const cancel = approval.status === "pending" && ownCall
      const stop =
        turn &&
        approval.runId === run.id &&
        approval.reportedInMessageId === undefined &&
        approval.turnStoppedAt === undefined
      if (!cancel && !stop) continue

      this.state.approvals.set(approvalKey, {
        ...approval,
        ...(cancel ? { status: "cancelled" as const } : {}),
        ...(stop ? { turnStoppedAt: new Date(at) } : {}),
      })
    }
  }

  /** A turn releases its conversation, a child run its own thread. */
  private releaseThread(run: AgentRunRecord, completedAt: Date): void {
    const threadKey = key(run.projectId, run.threadId)
    const thread = this.state.threads.get(threadKey)
    if (thread && thread.activeRunId === run.id) {
      this.state.threads.set(
        threadKey,
        clone({ ...thread, activeRunId: null, updatedAt: completedAt })
      )
    }
  }
}

// ── messages ──────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentMessageStore implements AgentMessageStore {
  constructor(private readonly state: AgentStoreState) {}

  async append(input: AppendAgentMessageInput): Promise<AgentMessageRecord> {
    const threadKey = key(input.projectId, input.threadId)
    const thread = this.state.threads.get(threadKey)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    const messageKey = key(input.projectId, input.id)
    if (this.state.messages.has(messageKey)) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent message '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    if (input.runId !== null && !this.state.runs.has(key(input.projectId, input.runId))) {
      throw new AgentStorageError(
        "run_not_found",
        `[Sixb] Agent run '${input.runId}' not found for project '${input.projectId}'.`
      )
    }

    const createdAt = new Date(input.createdAt ?? new Date())
    const seq = nextMessageSeq(this.state, input.projectId, input.threadId)
    const message: AgentMessageRecord = {
      id: input.id,
      projectId: input.projectId,
      threadId: input.threadId,
      runId: input.runId,
      role: input.role,
      ...(input.authorPrincipal === undefined
        ? {}
        : { authorPrincipal: clone(input.authorPrincipal) }),
      seq,
      parts: clone(input.parts),
      ...(input.metadata === undefined ? {} : { metadata: clone(input.metadata) }),
      contentVersion: AGENT_MESSAGE_CONTENT_VERSION,
      createdAt,
      ...(input.completedAt === undefined ? {} : { completedAt: new Date(input.completedAt) }),
    }
    this.state.messages.set(messageKey, clone(message))

    this.state.threads.set(
      threadKey,
      clone({
        ...thread,
        messageCount: thread.messageCount + (countsAsThreadMessage(input) ? 1 : 0),
        lastMessageAt: createdAt,
        updatedAt: createdAt,
      })
    )
    bumpMessageRevision(this.state, input.projectId, input.threadId)

    return clone(message)
  }

  async deleteByRunId(input: DeleteAgentMessagesByRunInput): Promise<number> {
    if (input.fence) {
      const owner = this.state.runs.get(key(input.projectId, input.fence.runId))
      if (owner?.status !== "running" || owner.execution?.token !== input.fence.executionToken) {
        throw new AgentStorageError(
          "execution_lost",
          `[Sixb] Execution token is no longer current on agent run '${input.fence.runId}'.`
        )
      }
    }
    const threadKey = key(input.projectId, input.threadId)
    const thread = this.state.threads.get(threadKey)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    const messages = [...this.state.messages.entries()].filter(
      ([, message]) =>
        message.projectId === input.projectId &&
        message.threadId === input.threadId &&
        message.runId === input.runId
    )
    if (messages.length === 0) {
      return 0
    }

    for (const [messageKey] of messages) {
      this.state.messages.delete(messageKey)
    }
    clampReadsToHead(this.state, input.projectId, input.threadId)
    forgetDeletedMessages(
      this.state,
      input.projectId,
      input.threadId,
      messages.map(([, message]) => message)
    )

    const remainingMessages = [...this.state.messages.values()]
      .filter(
        (message) => message.projectId === input.projectId && message.threadId === input.threadId
      )
      .sort((left, right) => right.seq - left.seq)
    const latestMessage = remainingMessages[0]
    const updatedAt = new Date()
    this.state.threads.set(
      threadKey,
      clone({
        ...thread,
        messageCount: remainingMessages.filter(countsAsThreadMessage).length,
        lastMessageAt: latestMessage?.createdAt,
        updatedAt,
      })
    )

    return messages.length
  }

  async deleteFromSeq(input: DeleteAgentMessagesFromSeqInput): Promise<number> {
    assertDeleteAgentMessagesFromSeqInput(input)
    const threadKey = key(input.projectId, input.threadId)
    const thread = this.state.threads.get(threadKey)
    if (!thread) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    const toDelete = [...this.state.messages.entries()].filter(
      ([, message]) =>
        message.projectId === input.projectId &&
        message.threadId === input.threadId &&
        message.seq >= input.fromSeq
    )
    if (toDelete.length === 0) return 0

    for (const [messageKey] of toDelete) {
      this.state.messages.delete(messageKey)
    }
    clampReadsToHead(this.state, input.projectId, input.threadId)
    forgetDeletedMessages(
      this.state,
      input.projectId,
      input.threadId,
      toDelete.map(([, message]) => message)
    )

    const remainingMessages = [...this.state.messages.values()]
      .filter(
        (message) => message.projectId === input.projectId && message.threadId === input.threadId
      )
      .sort((left, right) => right.seq - left.seq)
    const latestMessage = remainingMessages[0]
    const updatedAt = new Date()
    this.state.threads.set(
      threadKey,
      clone({
        ...thread,
        messageCount: remainingMessages.filter(countsAsThreadMessage).length,
        lastMessageAt: latestMessage?.createdAt,
        updatedAt,
      })
    )

    return toDelete.length
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentMessageRecord | null> {
    const record = this.state.messages.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async list(input: ListAgentMessagesInput): Promise<ListAgentMessagesResult> {
    const order = input.order ?? "asc"
    const roles = input.roles ? new Set(input.roles) : null

    const filtered = [...this.state.messages.values()]
      .filter((message) => message.projectId === input.projectId)
      .filter((message) => message.threadId === input.threadId)
      .filter((message) => (input.afterSeq === undefined ? true : message.seq > input.afterSeq))
      .filter((message) => (roles ? roles.has(message.role) : true))
      .sort((a, b) => (order === "asc" ? a.seq - b.seq : b.seq - a.seq))

    const { page, hasMore, total } = applyWindow(filtered, input.offset, input.limit)
    return { messages: page.map(clone), hasMore, total }
  }

  async listThreadIdsByArtifactContext(
    input: ListAgentThreadIdsByArtifactContextInput
  ): Promise<string[]> {
    const threadIds = new Set<string>()
    const { reader } = input

    for (const message of this.state.messages.values()) {
      if (message.projectId !== input.projectId || message.role !== "user") continue
      if (reader && !readsThread(this.state, input.projectId, message.threadId, reader)) continue

      const carries = message.parts.some(
        (part) =>
          part.type === "context" &&
          part.context.kind === "artifact" &&
          part.context.id === input.artifactId
      )
      if (carries) threadIds.add(message.threadId)
    }

    // Code-unit order, as SQLite compares text.
    return [...threadIds].sort((left, right) => (left < right ? -1 : 1))
  }
}

/** Whether `reader` owns the conversation or takes part in it. */
function readsThread(
  state: AgentStoreState,
  projectId: string,
  threadId: string,
  reader: Principal
): boolean {
  const thread = state.threads.get(key(projectId, threadId))
  if (thread?.kind !== "conversation") return false
  if (principalsEqual(thread.ownerPrincipal, reader)) return true

  const participants = state.participants.get(key(projectId, threadId)) ?? []
  return participants.some((participant) => principalsEqual(participant.principal, reader))
}

/** The `seq` of a thread's newest message, 0 when it has none. */
function headSeqOf(state: AgentStoreState, projectId: string, threadId: string): number {
  let max = 0
  for (const message of state.messages.values()) {
    if (message.projectId === projectId && message.threadId === threadId && message.seq > max) {
      max = message.seq
    }
  }
  return max
}

function nextMessageSeq(state: AgentStoreState, projectId: string, threadId: string): number {
  return headSeqOf(state, projectId, threadId) + 1
}

/**
 * Bring every place past the thread's newest message back to it, after a deletion. The next
 * message takes the number after the newest, so a place left past it would cover what a retry or
 * an edit writes next. Messages up to the newest kept their numbers and stay read.
 */
function clampReadsToHead(state: AgentStoreState, projectId: string, threadId: string): void {
  const headSeq = headSeqOf(state, projectId, threadId)
  for (const [readKey, read] of state.reads) {
    if (read.projectId !== projectId || read.threadId !== threadId) continue
    if (read.throughSeq > headSeq) state.reads.set(readKey, { ...read, throughSeq: headSeq })
  }
}

/** A message was added to the thread or taken from it: what was indexed before is behind. */
function bumpMessageRevision(state: AgentStoreState, projectId: string, threadId: string): void {
  const threadKey = key(projectId, threadId)
  state.messageRevisions.set(threadKey, (state.messageRevisions.get(threadKey) ?? 0) + 1)
}

/**
 * After a deletion, what the SQL providers' cascade and bookkeeping do: the vectors of the turns
 * whose opening message went, go, and indexing goes back to the turn that held the first message
 * taken, which may have lost its answer.
 */
function forgetDeletedMessages(
  state: AgentStoreState,
  projectId: string,
  threadId: string,
  deleted: readonly AgentMessageRecord[]
): void {
  bumpMessageRevision(state, projectId, threadId)

  const deletedIds = new Set(deleted.map((message) => message.id))
  for (const [vectorKey, vector] of state.turnVectors) {
    if (vector.projectId === projectId && deletedIds.has(vector.messageId)) {
      state.turnVectors.delete(vectorKey)
    }
  }

  const threadKey = key(projectId, threadId)
  const index = state.threadIndexes.get(threadKey)
  if (!index) return
  const firstDeleted = Math.min(...deleted.map((message) => message.seq))
  state.threadIndexes.set(threadKey, {
    ...index,
    staleFromSeq: Math.min(index.staleFromSeq ?? firstDeleted, firstDeleted),
  })
}

/**
 * A fork takes the indexed turns of the messages it copies, opening on the copies. Its index is
 * current when the source's was: no message arrived since, so a turn still running is a retry of
 * one indexed before, which the fork leaves out whole, vectors with it. Otherwise it goes on from
 * where the source's stood.
 */
function copyTurnVectors(
  state: AgentStoreState,
  input: ForkAgentThreadInput,
  copyIds: ReadonlyMap<string, string>
): void {
  const sourceKey = key(input.projectId, input.sourceThreadId)
  const index = state.threadIndexes.get(sourceKey)
  if (!index) return

  for (const vector of [...state.turnVectors.values()]) {
    if (vector.projectId !== input.projectId || vector.threadId !== input.sourceThreadId) continue
    const messageId = copyIds.get(vector.messageId)
    if (messageId === undefined) continue

    state.turnVectors.set(turnVectorKey(input.projectId, messageId, vector.chunk), {
      ...clone(vector),
      threadId: input.id,
      messageId,
    })
  }

  const current =
    index.revision === (state.messageRevisions.get(sourceKey) ?? 0) && index.staleFromSeq === null
  state.threadIndexes.set(key(input.projectId, input.id), {
    ...index,
    revision: current ? (state.messageRevisions.get(key(input.projectId, input.id)) ?? 0) : null,
    deferredUntil: null,
    failures: 0,
    haltedRevision: null,
  })
}

/**
 * Where a search starts when more chunks are eligible than it scores, from the eligible chunks'
 * times, the most recent first: the oldest time whose chunks all fit, so a search with `until` set
 * to it leaves none of a turn out. When even the newest time holds more chunks than fit, that time,
 * of which the first `candidates` are scored. `undefined` when every chunk fits.
 */
function turnSearchWindow(times: readonly Date[], candidates: number): Date | undefined {
  if (times.length <= candidates) return undefined

  const firstLeftOut = times[candidates]!
  const newer = times.slice(0, candidates).filter((time) => time > firstLeftOut)
  return newer.at(-1) ?? firstLeftOut
}

/** Ids order by code unit, as SQL's binary collation does. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Null for vectors of other lengths, which a search leaves out. */
function cosineSimilarity(stored: readonly number[], query: readonly number[]): number | null {
  if (stored.length !== query.length) return null

  let dot = 0
  let storedNorm = 0
  let queryNorm = 0
  for (let index = 0; index < query.length; index++) {
    dot += stored[index]! * query[index]!
    storedNorm += stored[index]! * stored[index]!
    queryNorm += query[index]! * query[index]!
  }
  if (storedNorm === 0 || queryNorm === 0) return null

  return Math.max(-1, Math.min(1, dot / Math.sqrt(storedNorm * queryNorm)))
}

function turnVectorKey(projectId: string, messageId: string, chunk: number): string {
  return JSON.stringify([projectId, messageId, chunk])
}

// ── turn vectors ──────────────────────────────────────────────────────────────────────────────

class InMemoryAgentTurnVectorStore implements AgentTurnVectorStore {
  constructor(private readonly state: AgentStoreState) {}

  async searchAvailable(): Promise<boolean> {
    return true
  }

  async defer(input: DeferAgentThreadIndexingInput): Promise<void> {
    const threadKey = key(input.projectId, input.threadId)
    if (!this.state.threads.has(threadKey)) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }

    const index = this.state.threadIndexes.get(threadKey) ?? {
      configuration: input.configuration,
      revision: null,
      staleFromSeq: null,
      deferredUntil: null,
      failures: 0,
      haltedRevision: null,
      indexedAt: null,
    }
    this.state.threadIndexes.set(threadKey, {
      ...index,
      deferredUntil: new Date(input.until),
      failures: index.failures + (input.failed ? 1 : 0),
    })
  }

  async progress(
    input: GetAgentThreadIndexProgressInput
  ): Promise<AgentThreadIndexProgress | null> {
    const threadKey = key(input.projectId, input.threadId)
    if (!this.state.threads.has(threadKey)) return null

    const revision = this.state.messageRevisions.get(threadKey) ?? 0
    const index = this.state.threadIndexes.get(threadKey)
    const opened = this.vectorsOf(input.projectId, input.threadId)
      .filter((vector) => vector.configuration === input.configuration)
      .map((vector) => vector.firstSeq)

    const newest = Math.max(1, ...opened)
    const stale = index?.staleFromSeq ?? null
    const holdingStale =
      stale === null ? newest : Math.max(1, ...opened.filter((seq) => seq <= stale))

    return {
      threadId: input.threadId,
      revision,
      current:
        index?.configuration === input.configuration &&
        index.revision === revision &&
        index.staleFromSeq === null,
      fromSeq: Math.min(newest, holdingStale),
      failures: index?.failures ?? 0,
      ...(index?.deferredUntil ? { deferredUntil: new Date(index.deferredUntil) } : {}),
      halted: index?.configuration === input.configuration && index.haltedRevision === revision,
    }
  }

  async halt(input: HaltAgentThreadIndexingInput): Promise<boolean> {
    const threadKey = key(input.projectId, input.threadId)
    if (!this.state.threads.has(threadKey)) return false
    if ((this.state.messageRevisions.get(threadKey) ?? 0) !== input.revision) return false

    // The state is about the configuration that failed now: under another, nothing is indexed.
    const index = this.state.threadIndexes.get(threadKey)
    const same = index?.configuration === input.configuration
    this.state.threadIndexes.set(threadKey, {
      configuration: input.configuration,
      revision: null,
      staleFromSeq: same ? index.staleFromSeq : null,
      deferredUntil: null,
      failures: 0,
      haltedRevision: input.revision,
      indexedAt: index?.indexedAt ?? null,
    })
    return true
  }

  async write(input: WriteAgentTurnVectorsInput): Promise<boolean> {
    assertWriteAgentTurnVectorsInput(input)

    const threadKey = key(input.projectId, input.threadId)
    if (!this.state.threads.has(threadKey)) return false
    if ((this.state.messageRevisions.get(threadKey) ?? 0) !== input.revision) return false

    // What the SQL providers' foreign key refuses: a turn opening on a message the thread lacks.
    for (const turn of input.turns) {
      const message = this.state.messages.get(key(input.projectId, turn.messageId))
      if (message?.threadId !== input.threadId) {
        throw new AgentStorageError(
          "invalid_input",
          `[Sixb] Agent message '${turn.messageId}' is not in thread '${input.threadId}'.`
        )
      }
    }

    for (const [vectorKey, vector] of this.state.turnVectors) {
      if (vector.projectId !== input.projectId || vector.threadId !== input.threadId) continue
      if (vector.firstSeq >= input.fromSeq || vector.configuration !== input.configuration) {
        this.state.turnVectors.delete(vectorKey)
      }
    }

    const indexedAt = new Date(input.indexedAt ?? new Date())
    for (const turn of input.turns) {
      this.state.turnVectors.set(turnVectorKey(input.projectId, turn.messageId, turn.chunk), {
        ...clone(turn),
        projectId: input.projectId,
        threadId: input.threadId,
        configuration: input.configuration,
        turnAt: new Date(turn.turnAt),
        indexedAt,
      })
    }

    // A deletion before `fromSeq` still waits for its turn; one at or after it is rewritten now.
    const previous = this.state.threadIndexes.get(threadKey)
    const stale =
      previous?.configuration === input.configuration &&
      previous.staleFromSeq !== null &&
      previous.staleFromSeq < input.fromSeq
        ? previous.staleFromSeq
        : null
    this.state.threadIndexes.set(threadKey, {
      configuration: input.configuration,
      revision: input.complete ? input.revision : null,
      staleFromSeq: stale,
      deferredUntil: null,
      failures: 0,
      haltedRevision: null,
      indexedAt,
    })

    return true
  }

  async list(input: ListAgentTurnVectorsInput): Promise<readonly AgentTurnVectorRecord[]> {
    return this.vectorsOf(input.projectId, input.threadId)
      .filter((vector) => vector.firstSeq >= (input.fromSeq ?? 1))
      .sort((left, right) => left.firstSeq - right.firstSeq || left.chunk - right.chunk)
      .map(clone)
  }

  async listThreadsToIndex(
    input: ListAgentThreadsToIndexInput
  ): Promise<readonly AgentThreadToIndex[]> {
    const activity = (thread: AgentThreadRecord) =>
      (thread.lastMessageAt ?? thread.createdAt).getTime()
    const now = (input.now ?? new Date()).getTime()

    return [...this.state.threads.values()]
      .filter((thread) => thread.projectId === input.projectId)
      .filter((thread) => thread.kind === "conversation" && thread.activeRunId === null)
      .filter((thread) => {
        const threadKey = key(thread.projectId, thread.id)
        const index = this.state.threadIndexes.get(threadKey)
        const revision = this.state.messageRevisions.get(threadKey) ?? 0
        if (index?.deferredUntil && index.deferredUntil.getTime() > now) return false
        if (index?.configuration === input.configuration && index.haltedRevision === revision) {
          return false
        }

        // A deletion moves the revision too, so a stale index is behind by it.
        return index?.configuration !== input.configuration || index.revision !== revision
      })
      .sort((left, right) => activity(right) - activity(left) || left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map((thread) => ({
        threadId: thread.id,
        revision: this.state.messageRevisions.get(key(thread.projectId, thread.id)) ?? 0,
      }))
  }

  async search(input: SearchAgentTurnVectorsInput): Promise<SearchAgentTurnVectorsResult> {
    assertSearchAgentTurnVectorsInput(input)

    const eligible = new Set(
      [...this.state.threads.values()]
        .filter((thread) => thread.projectId === input.projectId && thread.kind === "conversation")
        .filter((thread) => thread.id !== input.excludeThreadId)
        .filter((thread) => {
          const participants = this.state.participants.get(key(thread.projectId, thread.id)) ?? []
          if (input.scope === "shared" && participants.length === 0) return false

          const { principal } = input
          if (!principal) return true
          return (
            principalsEqual(thread.ownerPrincipal, principal) ||
            participants.some((participant) => principalsEqual(participant.principal, principal))
          )
        })
        .map((thread) => thread.id)
    )

    // The most recent eligible chunks first, the order SQL reads them in.
    const recent = [...this.state.turnVectors.values()]
      .filter((vector) => vector.projectId === input.projectId && eligible.has(vector.threadId))
      .filter((vector) => vector.configuration === input.configuration)
      .filter((vector) => !input.since || vector.turnAt >= input.since)
      .filter((vector) => !input.until || vector.turnAt < input.until)
      .sort(
        (left, right) =>
          right.turnAt.getTime() - left.turnAt.getTime() ||
          compareIds(left.threadId, right.threadId) ||
          compareIds(left.messageId, right.messageId) ||
          left.chunk - right.chunk
      )

    const searchedFrom = turnSearchWindow(
      recent.map((vector) => vector.turnAt),
      input.candidates
    )
    const candidates = recent
      .filter((vector) => !searchedFrom || vector.turnAt >= searchedFrom)
      .slice(0, input.candidates)

    // Each turn by its best chunk.
    const turns = new Map<string, AgentTurnSearchHit>()
    for (const vector of candidates) {
      const score = cosineSimilarity(vector.embedding, input.vector)
      if (score === null) continue

      const best = turns.get(vector.messageId)
      if (best && (best.score > score || (best.score === score && best.chunk < vector.chunk))) {
        continue
      }
      turns.set(vector.messageId, {
        threadId: vector.threadId,
        messageId: vector.messageId,
        chunk: vector.chunk,
        firstSeq: vector.firstSeq,
        lastSeq: vector.lastSeq,
        turnAt: new Date(vector.turnAt),
        text: vector.text,
        score,
      })
    }

    // Best first, then at most `perThread` turns of each conversation.
    const ranked = [...turns.values()].sort(
      (left, right) =>
        right.score - left.score ||
        right.turnAt.getTime() - left.turnAt.getTime() ||
        compareIds(left.threadId, right.threadId) ||
        compareIds(left.messageId, right.messageId)
    )
    const kept = new Map<string, number>()
    const hits = ranked.filter((hit) => {
      const count = kept.get(hit.threadId) ?? 0
      kept.set(hit.threadId, count + 1)
      return count < input.perThread
    })

    return {
      hits: hits.slice(0, input.k),
      ...(searchedFrom ? { searchedFrom: new Date(searchedFrom) } : {}),
    }
  }

  private vectorsOf(projectId: string, threadId: string): AgentTurnVectorRecord[] {
    return [...this.state.turnVectors.values()].filter(
      (vector) => vector.projectId === projectId && vector.threadId === threadId
    )
  }
}

// ── context checkpoints ──────────────────────────────────────────────────────────────────────

class InMemoryAgentContextCheckpointStore implements AgentContextCheckpointStore {
  constructor(private readonly state: AgentStoreState) {}

  async create(input: CreateAgentContextCheckpointInput): Promise<AgentContextCheckpointRecord> {
    assertCreateAgentContextCheckpointInput(input)

    // No `await` between authority checks and append: this is one in-memory critical section.
    const run = this.state.runs.get(key(input.projectId, input.createdByRunId)) ?? null
    const thread = this.state.threads.get(key(input.projectId, input.threadId)) ?? null
    assertAgentContextCheckpointAuthority({ create: input, run, thread })

    const messages = [...this.state.messages.values()].filter(
      (message) => message.projectId === input.projectId && message.threadId === input.threadId
    )
    const headSeq = messages.reduce((head, message) => Math.max(head, message.seq), 0)
    const latest = this.findLatest(input.projectId, input.threadId)

    const existingForRun = [...this.state.checkpoints.values()].find(
      (checkpoint) =>
        checkpoint.projectId === input.projectId &&
        checkpoint.threadId === input.threadId &&
        checkpoint.createdByRunId === input.createdByRunId
    )
    if (existingForRun) {
      if (agentContextCheckpointMatchesCreateInput(existingForRun, input)) {
        assertAgentContextCheckpointReplayState({
          create: input,
          existing: existingForRun,
          latest,
          headSeq,
        })
        return clone(existingForRun)
      }
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent run '${input.createdByRunId}' already created a different context checkpoint.`
      )
    }

    if (this.state.checkpoints.has(key(input.projectId, input.id))) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent context checkpoint '${input.id}' already exists for project '${input.projectId}'.`
      )
    }

    const firstRetained =
      messages
        .filter((message) => message.seq > input.summarizedThroughSeq)
        .sort((left, right) => left.seq - right.seq)[0] ?? null
    assertAgentContextCheckpointAnchors({
      create: input,
      latest,
      headSeq,
      firstRetained,
    })

    const record: AgentContextCheckpointRecord = {
      id: input.id,
      projectId: input.projectId,
      threadId: input.threadId,
      createdByRunId: input.createdByRunId,
      ...(input.expectedPreviousCheckpointId === null
        ? {}
        : { previousCheckpointId: input.expectedPreviousCheckpointId }),
      reason: input.reason,
      summary: input.summary,
      summaryFormatVersion: input.summaryFormatVersion,
      summarizedThroughSeq: input.summarizedThroughSeq,
      observedHeadSeq: input.observedHeadSeq,
      estimatedInputTokensBefore: input.estimatedInputTokensBefore,
      estimatedInputTokensAfter: input.estimatedInputTokensAfter,
      summaryModelId: input.summaryModelId,
      createdAt: new Date(input.createdAt ?? new Date()),
    }
    this.state.checkpoints.set(key(input.projectId, input.id), clone(record))
    return clone(record)
  }

  async getLatest(input: {
    readonly projectId: string
    readonly threadId: string
  }): Promise<AgentContextCheckpointRecord | null> {
    const record = this.findLatest(input.projectId, input.threadId)
    return record ? clone(record) : null
  }

  async deleteAfterSeq(input: DeleteAgentContextCheckpointsAfterSeqInput): Promise<number> {
    assertDeleteAgentContextCheckpointsAfterSeqInput(input)
    const matching = [...this.state.checkpoints.entries()].filter(
      ([, checkpoint]) =>
        checkpoint.projectId === input.projectId &&
        checkpoint.threadId === input.threadId &&
        checkpoint.observedHeadSeq > input.afterSeq
    )
    for (const [checkpointKey] of matching) {
      this.state.checkpoints.delete(checkpointKey)
    }
    return matching.length
  }

  async getByRunIds(input: {
    readonly projectId: string
    readonly threadId: string
    readonly runIds: readonly string[]
  }): Promise<readonly AgentContextCheckpointRecord[]> {
    const byRunId = new Map(
      [...this.state.checkpoints.values()]
        .filter((checkpoint) => checkpoint.projectId === input.projectId)
        .filter((checkpoint) => checkpoint.threadId === input.threadId)
        .map((checkpoint) => [checkpoint.createdByRunId, checkpoint] as const)
    )
    return [...new Set(input.runIds)].flatMap((runId) => {
      const checkpoint = byRunId.get(runId)
      return checkpoint ? [clone(checkpoint)] : []
    })
  }

  private findLatest(projectId: string, threadId: string): AgentContextCheckpointRecord | null {
    return (
      [...this.state.checkpoints.values()]
        .filter(
          (checkpoint) => checkpoint.projectId === projectId && checkpoint.threadId === threadId
        )
        .sort(compareLatestCheckpoints)[0] ?? null
    )
  }
}

/** The order `getLatest` reads: the furthest boundary, then the newest. */
function compareLatestCheckpoints(
  left: AgentContextCheckpointRecord,
  right: AgentContextCheckpointRecord
): number {
  return (
    right.summarizedThroughSeq - left.summarizedThroughSeq ||
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  )
}

// ── memory ────────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentMemoryStore implements AgentMemoryStore {
  constructor(private readonly state: AgentStoreState) {}

  async get(input: {
    projectId: string
    repoId: string
    asOf?: Date
    revision?: number
  }): Promise<AgentMemoryRepoRecord> {
    const repo = this.state.memory.get(key(input.projectId, input.repoId))
    const { asOf, revision: upTo } = input
    const saved = repo?.revisions.filter(
      (entry) =>
        (!asOf || entry.createdAt.getTime() <= asOf.getTime()) &&
        (upTo === undefined || entry.revision <= upTo)
    )
    const revision = saved?.reduce((highest, entry) => Math.max(highest, entry.revision), 0) ?? 0
    if (!repo || revision === 0) return { revision: 0, files: [] }
    const files = [
      ...latestMemoryFiles({
        revisions: repo.revisions,
        files: repo.files.filter((file) => file.revision <= revision),
      }).values(),
    ]
      .flatMap((file) =>
        file.contents === null ? [] : [{ path: file.path, contents: file.contents }]
      )
      .sort((left, right) => compareAgentMemoryPaths(left.path, right.path))
    return { revision, files }
  }

  async save(input: SaveAgentMemoryInput): Promise<SaveAgentMemoryResult> {
    assertSaveAgentMemoryInput(input)
    const repoKey = key(input.projectId, input.repoId)
    const repo = this.state.memory.get(repoKey) ?? { revisions: [], files: [] }
    const head = repo.revisions.at(-1)?.revision ?? 0
    const conflicts = agentMemoryConflicts(input, head, latestMemoryFiles(repo))
    if (conflicts.length > 0) return { saved: false, revision: head, conflicts }

    const revision = head + 1
    const createdAt = input.createdAt ?? new Date()
    const revisions = [
      ...repo.revisions,
      {
        revision,
        message: input.message,
        author: clone(input.author),
        ...(input.source === undefined ? {} : { source: input.source }),
        createdAt: new Date(createdAt),
      },
    ]
    const files = [...repo.files, ...input.changes.map((change) => ({ ...change, revision }))]

    const cutoff = agentMemoryHistoryCutoff(createdAt).getTime()
    const savedAt = new Map(revisions.map((entry) => [entry.revision, entry.createdAt.getTime()]))
    const latest = latestMemoryFiles({ revisions, files })
    this.state.memory.set(repoKey, {
      revisions,
      files: files.filter(
        (file) => latest.get(file.path) === file || (savedAt.get(file.revision) ?? 0) >= cutoff
      ),
    })
    return { saved: true, revision }
  }

  async listRevisions(
    input: ListAgentMemoryRevisionsInput
  ): Promise<ListAgentMemoryRevisionsResult> {
    const repo = this.state.memory.get(key(input.projectId, input.repoId))
    const newestFirst = [...(repo?.revisions ?? [])].reverse()
    const { page, hasMore, total } = applyWindow(newestFirst, input.offset, input.limit)
    const revisions = page.map(
      (entry): AgentMemoryRevisionRecord => ({
        ...clone(entry),
        changes: (repo?.files ?? [])
          .filter((file) => file.revision === entry.revision)
          .map((file) => ({ path: file.path, deleted: file.contents === null }))
          .sort((left, right) => compareAgentMemoryPaths(left.path, right.path)),
      })
    )
    return { revisions, hasMore, total }
  }

  async delete(input: { projectId: string; repoId: string }): Promise<void> {
    this.state.memory.delete(key(input.projectId, input.repoId))
  }
}

/** Each path's highest-revision version, the deleted ones included. */
function latestMemoryFiles(
  repo: StoredAgentMemoryRepo
): Map<string, StoredAgentMemoryRepo["files"][number]> {
  const latest = new Map<string, StoredAgentMemoryRepo["files"][number]>()
  for (const file of repo.files) latest.set(file.path, file)
  return latest
}

// ── approvals ─────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentApprovalStore implements AgentApprovalStore {
  constructor(private readonly state: AgentStoreState) {}

  async request(input: RequestAgentApprovalInput): Promise<RequestAgentApprovalResult> {
    assertRequestAgentApprovalInput(input)

    const threadId = assertAgentApprovalCaller({
      request: input,
      turn: this.state.runs.get(key(input.projectId, input.runId)) ?? null,
      caller: this.state.runs.get(key(input.projectId, input.callerRunId)) ?? null,
    })
    const callKey = agentApprovalCallKey(input.call)
    const live = [...this.state.approvals.values()].find(
      (approval) =>
        approval.projectId === input.projectId &&
        approval.threadId === threadId &&
        approval.callKey === callKey &&
        (LIVE_AGENT_APPROVAL_STATUSES as readonly string[]).includes(approval.status)
    )
    if (live) return { approval: clone(live), created: false }

    if (this.state.approvals.has(key(input.projectId, input.id))) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent approval '${input.id}' already exists for project '${input.projectId}'.`
      )
    }
    const approval = newAgentApprovalRecord(input, threadId)
    this.state.approvals.set(key(input.projectId, input.id), clone(approval))
    return { approval: clone(approval), created: true }
  }

  async decide(input: DecideAgentApprovalInput): Promise<DecideAgentApprovalResult | null> {
    const approvalKey = key(input.projectId, input.id)
    const approval = this.state.approvals.get(approvalKey)
    if (!approval) return null
    if (approval.status !== "pending") return { approval: clone(approval), decided: false }

    const decidedAt = new Date(input.decidedAt ?? new Date())
    const next: AgentApprovalRecord =
      approval.expiresAt <= decidedAt
        ? { ...approval, status: "expired" }
        : {
            ...approval,
            status: input.decision,
            decidedAt,
            decidedBy: clone(input.decidedBy),
            ...(input.decision === "approved" && input.raisedMode !== undefined
              ? { raisedMode: input.raisedMode }
              : {}),
          }
    this.state.approvals.set(approvalKey, clone(next))
    return { approval: clone(next), decided: next.status === input.decision }
  }

  async recordOutcome(input: {
    readonly projectId: string
    readonly id: string
    readonly outcome: AgentApprovalOutcome
  }): Promise<AgentApprovalRecord> {
    const approvalKey = key(input.projectId, input.id)
    const approval = this.state.approvals.get(approvalKey)
    if (!approval) {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent approval '${input.id}' not found for project '${input.projectId}'.`
      )
    }
    if (approval.status !== "approved") {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent approval '${input.id}' is not approved (status '${approval.status}').`
      )
    }
    if (approval.outcome) return clone(approval)

    const next = { ...approval, outcome: clone(input.outcome) }
    this.state.approvals.set(approvalKey, clone(next))
    return clone(next)
  }

  async settle(input: SettleAgentApprovalsInput): Promise<readonly AgentApprovalRecord[]> {
    const settled: AgentApprovalRecord[] = []
    for (const [approvalKey, approval] of this.state.approvals) {
      if (
        approval.projectId !== input.projectId ||
        approval.threadId !== input.threadId ||
        approval.status !== "pending"
      ) {
        continue
      }
      const next = { ...approval, status: input.status }
      this.state.approvals.set(approvalKey, clone(next))
      settled.push(next)
    }
    return settled.sort(compareApprovals).map(clone)
  }

  async expireDue(input: {
    readonly projectId: string
    readonly now: Date
    readonly limit?: number
  }): Promise<readonly AgentApprovalRecord[]> {
    const due = [...this.state.approvals.values()]
      .filter(
        (approval) =>
          approval.projectId === input.projectId &&
          approval.status === "pending" &&
          approval.expiresAt <= input.now
      )
      .sort(compareApprovals)
      .slice(0, input.limit)

    return due.map((approval) => {
      const next = { ...approval, status: "expired" as const }
      this.state.approvals.set(key(approval.projectId, approval.id), clone(next))
      return clone(next)
    })
  }

  async stop(input: StopAgentApprovalsInput): Promise<StopAgentApprovalsResult> {
    const stoppedAt = new Date(input.stoppedAt ?? new Date())
    const cancelled: AgentApprovalRecord[] = []
    let stopped = 0
    for (const [approvalKey, approval] of this.state.approvals) {
      if (!agentApprovalStops(approval, input)) continue

      const cancel = approval.status === "pending"
      const stop = approval.turnStoppedAt === undefined
      if (!cancel && !stop) continue
      const next: AgentApprovalRecord = {
        ...approval,
        ...(cancel ? { status: "cancelled" as const } : {}),
        ...(stop ? { turnStoppedAt: stoppedAt } : {}),
      }
      this.state.approvals.set(approvalKey, clone(next))
      if (cancel) cancelled.push(next)
      if (stop) stopped += 1
    }
    return { cancelled: cancelled.sort(compareApprovals).map(clone), stopped }
  }

  async rewind(input: RewindAgentApprovalsInput): Promise<RewindAgentApprovalsResult> {
    const runIds = new Set(input.runIds)
    const clearedIds = new Set(input.clearedMessageIds ?? [])
    const cancelledAt = new Date(input.cancelledAt ?? new Date())
    const cancelled: AgentApprovalRecord[] = []
    let deleted = 0

    for (const [approvalKey, approval] of [...this.state.approvals.entries()]) {
      if (approval.projectId !== input.projectId || approval.threadId !== input.threadId) continue

      if (runIds.has(approval.runId)) {
        this.state.approvals.delete(approvalKey)
        deleted += 1
        if (approval.status === "pending") {
          cancelled.push({
            ...approval,
            status: "cancelled",
            turnStoppedAt: approval.turnStoppedAt ?? cancelledAt,
          })
        }
        continue
      }

      if (approval.reportedInMessageId && clearedIds.has(approval.reportedInMessageId)) {
        const { reportedInMessageId: _reported, ...unreported } = approval
        this.state.approvals.set(approvalKey, clone(unreported))
      }
    }

    return { cancelled: cancelled.sort(compareApprovals).map(clone), deleted }
  }

  async holdsRun(input: { readonly projectId: string; readonly runId: string }): Promise<boolean> {
    return holdsRun(this.state, input.projectId, input.runId)
  }

  async claimExecution(input: {
    readonly projectId: string
    readonly id: string
    readonly claimedAt: Date
    readonly staleBefore: Date
  }): Promise<AgentApprovalRecord | null> {
    const approvalKey = key(input.projectId, input.id)
    const approval = this.state.approvals.get(approvalKey)
    if (!approval || !agentApprovalClaimable(approval, input.staleBefore)) return null

    const next = { ...approval, executionClaimedAt: new Date(input.claimedAt) }
    this.state.approvals.set(approvalKey, clone(next))
    return clone(next)
  }

  async listRepairable(input: {
    readonly projectId: string
    readonly claimableBefore: Date
    readonly after?: AgentApprovalCursor
    readonly limit: number
  }): Promise<readonly AgentApprovalRecord[]> {
    const { after } = input
    return [...this.state.approvals.values()]
      .filter(
        (approval) =>
          approval.projectId === input.projectId &&
          agentApprovalRepairable(approval, input.claimableBefore) &&
          (after === undefined ||
            approval.createdAt > after.createdAt ||
            (approval.createdAt.getTime() === after.createdAt.getTime() && approval.id > after.id))
      )
      .sort(compareApprovals)
      .slice(0, input.limit)
      .map(clone)
  }

  async markReported(input: MarkAgentApprovalsReportedInput): Promise<readonly string[]> {
    const marked: string[] = []
    for (const id of new Set(input.ids)) {
      const approvalKey = key(input.projectId, id)
      const approval = this.state.approvals.get(approvalKey)
      if (
        !approval ||
        approval.threadId !== input.threadId ||
        approval.reportedInMessageId !== undefined ||
        (input.resuming === true && approval.turnStoppedAt !== undefined)
      ) {
        continue
      }
      this.state.approvals.set(approvalKey, { ...approval, reportedInMessageId: input.messageId })
      marked.push(id)
    }
    return marked
  }

  async getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AgentApprovalRecord | null> {
    const approval = this.state.approvals.get(key(params.projectId, params.id))
    return approval ? clone(approval) : null
  }

  async list(input: ListAgentApprovalsInput): Promise<ListAgentApprovalsResult> {
    const matching = [...this.state.approvals.values()]
      .filter((approval) => agentApprovalMatches(approval, input))
      .sort(compareApprovals)
    const { page, hasMore, total } = applyWindow(matching, input.offset, input.limit)
    return { approvals: page.map(clone), hasMore, total }
  }
}

function holdsRun(state: AgentStoreState, projectId: string, runId: string): boolean {
  return [...state.approvals.values()].some(
    (approval) => approval.projectId === projectId && agentApprovalHoldsRun(approval, runId)
  )
}

/** Oldest first, then by id: the order every provider lists approvals in. */
function compareApprovals(left: AgentApprovalRecord, right: AgentApprovalRecord): number {
  return compareByDate(left.createdAt, right.createdAt, left.id, right.id, "asc")
}

/** Leases, not history: they stay out of snapshots, which roll back transactional writes. */
class InMemoryAgentComputerSessionStore implements AgentComputerSessionStore {
  private readonly sessions = new Map<string, AgentComputerSessionRecord>()

  async hold(input: Omit<AgentComputerSessionRecord, "stopRequests">): Promise<void> {
    assertAgentComputerSession(input)
    const { backgroundCommands, ...session } = input
    const stopRequests = this.sessions.get(sessionKey(input))?.stopRequests
    this.sessions.set(
      sessionKey(input),
      clone({
        ...session,
        ...(backgroundCommands?.length ? { backgroundCommands } : {}),
        ...(stopRequests?.length ? { stopRequests } : {}),
      })
    )
  }

  async requestStop(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
    readonly command: AgentBackgroundCommandRef
  }): Promise<AgentComputerSessionRecord | null> {
    assertAgentBackgroundCommandRef(input.command)
    const held = this.sessions.get(sessionKey(input))
    if (!held) return null

    const next = { ...held, stopRequests: withStopRequest(held.stopRequests ?? [], input.command) }
    this.sessions.set(sessionKey(input), clone(next))
    return clone(next)
  }

  async release(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
  }): Promise<AgentComputerSessionRecord | null> {
    const held = this.sessions.get(sessionKey(input)) ?? null
    this.sessions.delete(sessionKey(input))
    return held && clone(held)
  }

  async listLive(input: {
    readonly projectId: string
    readonly ownerPrincipal: Principal
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.projectId === input.projectId &&
          principalsEqual(session.ownerPrincipal, input.ownerPrincipal) &&
          session.expiresAt > input.now
      )
      .map(clone)
  }

  async removeLapsed(input: {
    readonly projectId: string
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]> {
    const lapsed = [...this.sessions.values()].filter(
      (session) => session.projectId === input.projectId && session.expiresAt <= input.now
    )
    for (const session of lapsed) this.sessions.delete(sessionKey(session))
    return lapsed.map(clone)
  }
}

function sessionKey(input: {
  readonly projectId: string
  readonly id: string
  readonly ownerPrincipal: Principal
}): string {
  return JSON.stringify([input.projectId, principalKeyOf(input.ownerPrincipal), input.id])
}

function principalKeyOf(principal: Principal): string {
  return `${principal.type}:${principal.id}`
}

class InMemoryAgentApprovalModeStore implements AgentApprovalModeStore {
  constructor(private readonly state: AgentStoreState) {}

  async getDefault(input: {
    readonly projectId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    return this.state.approvalModes.get(defaultModeKey(input)) ?? null
  }

  async setDefault(input: {
    readonly projectId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode
  }): Promise<void> {
    assertAgentApprovalModeInput(input.mode)
    this.state.approvalModes.set(defaultModeKey(input), input.mode)
  }

  async getForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null> {
    return this.state.approvalModes.get(threadModeKey(input)) ?? null
  }

  async setForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode | null
  }): Promise<void> {
    if (input.mode !== null) assertAgentApprovalModeInput(input.mode)
    if (!this.state.threads.has(key(input.projectId, input.threadId))) {
      throw new AgentStorageError(
        "thread_not_found",
        `[Sixb] Agent thread '${input.threadId}' not found for project '${input.projectId}'.`
      )
    }
    if (input.mode === null) {
      this.state.approvalModes.delete(threadModeKey(input))
      return
    }
    this.state.approvalModes.set(threadModeKey(input), input.mode)
  }
}

function defaultModeKey(input: { readonly projectId: string; readonly principal: Principal }) {
  return JSON.stringify([input.projectId, input.principal.type, input.principal.id])
}

function threadModeKey(input: {
  readonly projectId: string
  readonly threadId: string
  readonly principal: Principal
}) {
  return JSON.stringify([input.projectId, input.threadId, input.principal.type, input.principal.id])
}

// ── token rates ───────────────────────────────────────────────────────────────────────────────

class InMemoryAgentTokenRateStore implements AgentTokenRateStore {
  constructor(private readonly state: AgentStoreState) {}

  async record(input: AgentTokenRateRecord): Promise<void> {
    assertAgentTokenRateRecord(input)

    this.state.tokenRates.set(JSON.stringify([input.projectId, input.runId]), { ...input })

    const dropped = this.ofModel(input).slice(AGENT_TOKEN_RATE_SAMPLES)
    for (const record of dropped) {
      this.state.tokenRates.delete(JSON.stringify([record.projectId, record.runId]))
    }
  }

  async listLatest(input: {
    readonly projectId: string
    readonly providerId: string
    readonly modelId: string
  }): Promise<readonly AgentTokenRateRecord[]> {
    return this.ofModel(input)
      .slice(0, AGENT_TOKEN_RATE_SAMPLES)
      .map((record) => ({ ...record }))
  }

  /** Newest first, then by run id, descending: the order every provider keeps and lists. */
  private ofModel(model: {
    readonly projectId: string
    readonly providerId: string
    readonly modelId: string
  }): AgentTokenRateRecord[] {
    return [...this.state.tokenRates.values()]
      .filter(
        (record) =>
          record.projectId === model.projectId &&
          record.providerId === model.providerId &&
          record.modelId === model.modelId
      )
      .sort((left, right) =>
        compareByDate(left.measuredAt, right.measuredAt, left.runId, right.runId, "desc")
      )
  }
}

// -- inbox ------------------------------------------------------------------------------------

class InMemoryAgentInboxStore implements AgentInboxStore {
  constructor(private readonly state: AgentStoreState) {}

  async enqueue(input: EnqueueAgentInboxItemInput): Promise<EnqueueAgentInboxItemResult> {
    assertEnqueueAgentInboxItemInput(input, "Sixb")

    const itemKey = key(input.projectId, input.id)
    const existing = this.state.inbox.get(itemKey)
    if (existing) {
      if (existing.threadId === input.threadId) {
        return { item: clone(existing), created: false }
      }
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent inbox item '${input.id}' already exists on another thread in project '${input.projectId}'.`
      )
    }

    const thread = this.state.threads.get(key(input.projectId, input.threadId)) ?? null
    const threadItems = this.threadItems(input.projectId, input.threadId)
    assertInboxThreadAcceptsItem(
      thread,
      input.threadId,
      input.projectId,
      threadItems.length,
      "Sixb"
    )

    if (
      this.state.messages.has(key(input.projectId, input.messageId)) ||
      [...this.state.inbox.values()].some(
        (item) => item.projectId === input.projectId && item.messageId === input.messageId
      )
    ) {
      throw new AgentStorageError(
        "duplicate_id",
        `[Sixb] Agent message '${input.messageId}' already exists for project '${input.projectId}'.`
      )
    }

    const seq = threadItems.reduce((max, item) => Math.max(max, item.seq), 0) + 1
    const record = newAgentInboxItemRecord(input, seq)
    this.state.inbox.set(itemKey, clone(record))
    return { item: clone(record), created: true }
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentInboxItemRecord | null> {
    const record = this.state.inbox.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async list(input: ListAgentInboxItemsInput): Promise<readonly AgentInboxItemRecord[]> {
    const includeClaimed = input.includeClaimed ?? true
    return this.threadItems(input.projectId, input.threadId)
      .filter((item) => includeClaimed || item.claimedBy === undefined)
      .map(clone)
  }

  async update(input: UpdateAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    assertUpdateAgentInboxItemInput(input, "Sixb")
    const itemKey = key(input.projectId, input.id)
    const current = this.state.inbox.get(itemKey)
    if (!current || current.threadId !== input.threadId) return null

    const next = updatedAgentInboxItemRecord(current, input)
    this.state.inbox.set(itemKey, clone(next))
    return clone(next)
  }

  async remove(input: RemoveAgentInboxItemInput): Promise<AgentInboxItemRecord | null> {
    const itemKey = key(input.projectId, input.id)
    const current = this.state.inbox.get(itemKey)
    if (!current || current.threadId !== input.threadId) return null
    if (current.claimedBy !== undefined) {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent inbox item '${current.id}' was already claimed by run '${current.claimedBy.runId}'.`
      )
    }
    this.state.inbox.delete(itemKey)
    return clone(current)
  }

  async takeSteers(input: TakeAgentInboxSteersInput): Promise<readonly AgentInboxItemRecord[]> {
    assertTakeAgentInboxSteersInput(input, "Sixb")
    const run = this.state.runs.get(key(input.projectId, input.runId)) ?? null
    assertInboxRunOwnership(run, input, "Sixb")

    const now = new Date()
    const claimed: AgentInboxItemRecord[] = []
    for (const item of this.threadItems(input.projectId, input.threadId)) {
      if (item.mode !== "steer" || item.immediate) continue
      if (!principalsEqual(item.authorPrincipal, input.authorPrincipal)) continue
      if (
        item.claimedBy?.runId === input.runId &&
        item.claimedBy.executionToken === input.executionToken
      ) {
        continue
      }
      const next: AgentInboxItemRecord = {
        ...item,
        claimedBy: {
          runId: input.runId,
          executionToken: input.executionToken,
          stepIndex: input.stepIndex,
          ...(input.afterAnswer ? { afterAnswer: true } : {}),
        },
        updatedAt: now,
      }
      this.state.inbox.set(key(item.projectId, item.id), clone(next))
      claimed.push(clone(next))
    }
    return claimed
  }

  async consumeClaimed(
    input: ConsumeClaimedAgentInboxInput
  ): Promise<readonly AgentInboxItemRecord[]> {
    const run = this.state.runs.get(key(input.projectId, input.runId)) ?? null
    assertInboxRunOwnership(run, input, "Sixb")

    const persisted = new Set(input.messageIds)
    const now = new Date()
    const consumed: AgentInboxItemRecord[] = []
    for (const item of this.threadItems(input.projectId, input.threadId)) {
      if (
        item.claimedBy?.runId !== input.runId ||
        item.claimedBy.executionToken !== input.executionToken
      ) {
        continue
      }
      const itemKey = key(item.projectId, item.id)
      if (persisted.has(item.messageId)) {
        this.state.inbox.delete(itemKey)
        consumed.push(clone(item))
      } else {
        const { claimedBy: _claimedBy, ...rest } = item
        this.state.inbox.set(itemKey, clone({ ...rest, updatedAt: now }))
      }
    }
    return consumed
  }

  async releaseClaimed(input: { projectId: string; runId: string }): Promise<number> {
    const now = new Date()
    let released = 0
    for (const [itemKey, item] of this.state.inbox) {
      if (item.projectId !== input.projectId || item.claimedBy?.runId !== input.runId) continue
      const { claimedBy: _claimedBy, ...rest } = item
      this.state.inbox.set(itemKey, clone({ ...rest, updatedAt: now }))
      released += 1
    }
    return released
  }

  async takeNextQueued(input: TakeNextQueuedAgentInboxInput): Promise<AgentInboxItemRecord | null> {
    const thread = this.state.threads.get(key(input.projectId, input.threadId))
    if (!thread || thread.status !== "active" || thread.activeRunId !== null) return null

    const candidates = this.threadItems(input.projectId, input.threadId)
      .filter(
        (item) =>
          item.claimedBy === undefined &&
          (!input.onlyImmediate || item.immediate) &&
          (input.authorPrincipal === undefined ||
            principalsEqual(item.authorPrincipal, input.authorPrincipal))
      )
      .sort((left, right) => inboxPriority(left) - inboxPriority(right) || left.seq - right.seq)
    const winner = candidates[0]
    if (!winner) return null

    this.state.inbox.delete(key(winner.projectId, winner.id))
    return clone(winner)
  }

  async listWaitingThreads(input: ListWaitingAgentInboxThreadsInput): Promise<readonly string[]> {
    const ids = new Set<string>()
    for (const item of this.state.inbox.values()) {
      if (item.projectId !== input.projectId) continue
      if (item.createdAt.getTime() >= input.createdBefore.getTime()) continue
      if (input.afterThreadId !== undefined && item.threadId <= input.afterThreadId) continue
      const thread = this.state.threads.get(key(item.projectId, item.threadId))
      if (!thread || thread.activeRunId !== null) continue
      ids.add(item.threadId)
    }
    return [...ids].sort().slice(0, input.limit)
  }

  private threadItems(projectId: string, threadId: string): AgentInboxItemRecord[] {
    return [...this.state.inbox.values()]
      .filter((item) => item.projectId === projectId && item.threadId === threadId)
      .sort((left, right) => left.seq - right.seq)
  }
}

function inboxPriority(item: Pick<AgentInboxItemRecord, "immediate" | "mode">): number {
  if (item.immediate) return 0
  return item.mode === "steer" ? 1 : 2
}

export class InMemoryAgentStorage implements AgentStorage {
  private readonly state: AgentStoreState = {
    threads: new Map(),
    participants: new Map(),
    reads: new Map(),
    runs: new Map(),
    messages: new Map(),
    checkpoints: new Map(),
    memory: new Map(),
    approvals: new Map(),
    approvalModes: new Map(),
    tokenRates: new Map(),
    inbox: new Map(),
    messageRevisions: new Map(),
    turnVectors: new Map(),
    threadIndexes: new Map(),
  }

  readonly threads: InMemoryAgentThreadStore
  readonly reads: InMemoryAgentThreadReadStore
  readonly runs: InMemoryAgentRunStore
  readonly messages: InMemoryAgentMessageStore
  readonly checkpoints: InMemoryAgentContextCheckpointStore
  readonly memory: InMemoryAgentMemoryStore
  readonly approvals: InMemoryAgentApprovalStore
  readonly approvalModes: InMemoryAgentApprovalModeStore
  readonly tokenRates: InMemoryAgentTokenRateStore
  readonly inbox: InMemoryAgentInboxStore
  readonly turnVectors: InMemoryAgentTurnVectorStore
  readonly computers = new InMemoryAgentComputerSessionStore()

  constructor(executions: ExecutionStorage) {
    this.threads = new InMemoryAgentThreadStore(this.state)
    this.reads = new InMemoryAgentThreadReadStore(this.state)
    this.runs = new InMemoryAgentRunStore(this.state, executions)
    this.messages = new InMemoryAgentMessageStore(this.state)
    this.checkpoints = new InMemoryAgentContextCheckpointStore(this.state)
    this.memory = new InMemoryAgentMemoryStore(this.state)
    this.approvals = new InMemoryAgentApprovalStore(this.state)
    this.approvalModes = new InMemoryAgentApprovalModeStore(this.state)
    this.tokenRates = new InMemoryAgentTokenRateStore(this.state)
    this.inbox = new InMemoryAgentInboxStore(this.state)
    this.turnVectors = new InMemoryAgentTurnVectorStore(this.state)
  }

  snapshot(): InMemoryAgentStorageSnapshot {
    return {
      threads: structuredClone(this.state.threads),
      participants: structuredClone(this.state.participants),
      reads: structuredClone(this.state.reads),
      runs: structuredClone(this.state.runs),
      messages: structuredClone(this.state.messages),
      checkpoints: structuredClone(this.state.checkpoints),
      memory: structuredClone(this.state.memory),
      approvals: structuredClone(this.state.approvals),
      approvalModes: structuredClone(this.state.approvalModes),
      tokenRates: structuredClone(this.state.tokenRates),
      inbox: structuredClone(this.state.inbox),
      messageRevisions: structuredClone(this.state.messageRevisions),
      turnVectors: structuredClone(this.state.turnVectors),
      threadIndexes: structuredClone(this.state.threadIndexes),
    }
  }

  restore(snapshot: InMemoryAgentStorageSnapshot): void {
    replace(this.state.threads, snapshot.threads)
    replace(this.state.participants, snapshot.participants)
    replace(this.state.reads, snapshot.reads)
    replace(this.state.runs, snapshot.runs)
    replace(this.state.messages, snapshot.messages)
    replace(this.state.checkpoints, snapshot.checkpoints)
    replace(this.state.memory, snapshot.memory)
    replace(this.state.approvals, snapshot.approvals)
    replace(this.state.approvalModes, snapshot.approvalModes)
    replace(this.state.tokenRates, snapshot.tokenRates)
    replace(this.state.inbox, snapshot.inbox)
    replace(this.state.messageRevisions, snapshot.messageRevisions)
    replace(this.state.turnVectors, snapshot.turnVectors)
    replace(this.state.threadIndexes, snapshot.threadIndexes)
  }
}

function replace<T>(target: Map<string, T>, source: Map<string, T>): void {
  target.clear()
  for (const [k, value] of structuredClone(source)) {
    target.set(k, value)
  }
}

function leaseStillHeld(id: string): AgentStorageError {
  return new AgentStorageError(
    "invalid_state",
    `[Sixb] Agent run '${id}' is still held by its runner, whose lease has not lapsed.`
  )
}
