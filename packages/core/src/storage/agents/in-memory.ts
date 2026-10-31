import { AGENT_MESSAGE_CONTENT_VERSION } from "../../agents/message"
import { type Principal, principalsEqual } from "../../auth"
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
  assertAgentComputerSession,
  assertAgentContextCheckpointAnchors,
  assertAgentContextCheckpointAuthority,
  assertAgentContextCheckpointReplayState,
  assertAgentRunExecution,
  assertAgentRunFinishPayload,
  assertAgentThreadComputer,
  assertAssignableComputer,
  assertAwaitingApprovalFinish,
  assertComputerPlace,
  assertConversationAgentRunSpec,
  assertConversationThreadRow,
  assertCreateAgentContextCheckpointInput,
  assertCreateSubagentRunInput,
  assertMovableToCloud,
  assertRequestAgentApprovalInput,
  assertSaveAgentMemoryInput,
  assertStartsOnComputer,
  assertSubagentThreadTakesRun,
  assertTurnInThreadPlace,
  cloudSpec,
  compareAgentMemoryPaths,
  compareAgentThreadParticipants,
  countsAsThreadMessage,
  LIVE_AGENT_APPROVAL_STATUSES,
  movesComputerPlace,
  newAgentApprovalRecord,
  newSubagentThreadRecord,
  participantsToAdd,
  planAgentThreadFork,
  remapArtifactIds,
  snapshotAgentThreadSandboxParams,
  subagentRunMatchesCreateInput,
  transitionAgentThreadSandbox,
} from "./provider"
import type {
  AddAgentThreadParticipantsInput,
  AgentApprovalCursor,
  AgentApprovalMode,
  AgentApprovalModeStore,
  AgentApprovalOutcome,
  AgentApprovalRecord,
  AgentApprovalStore,
  AgentComputerSessionRecord,
  AgentComputerSessionStore,
  AgentContextCheckpointRecord,
  AgentContextCheckpointStore,
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
  AgentThreadParticipantRecord,
  AgentThreadRecord,
  AgentThreadSandboxState,
  AgentThreadStore,
  AppendAgentMessageInput,
  AssignAgentThreadComputerInput,
  ConfirmAgentRunExecutionOwnershipInput,
  ConversationAgentRunRecord,
  CreateAgentContextCheckpointInput,
  CreateAgentRunInput,
  CreateAgentThreadInput,
  CreateSubagentRunInput,
  DecideAgentApprovalInput,
  DecideAgentApprovalResult,
  DeleteAgentMessagesByRunInput,
  FinishAgentRunInput,
  FinishQueuedAgentRunInput,
  ForkAgentThreadInput,
  ListAgentApprovalsInput,
  ListAgentApprovalsResult,
  ListAgentMemoryRevisionsInput,
  ListAgentMemoryRevisionsResult,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadChildrenInput,
  ListAgentThreadParticipantsInput,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ListThreadSubagentsInput,
  MarkAgentApprovalsReportedInput,
  MoveAgentThreadToCloudInput,
  MoveAgentThreadToCloudResult,
  ReclaimAgentRunInput,
  RemoveAgentThreadParticipantInput,
  RequestAgentApprovalInput,
  RequestAgentApprovalResult,
  RequestAgentRunCancelInput,
  SaveAgentMemoryInput,
  SaveAgentMemoryResult,
  SettleAgentApprovalsInput,
  StartAgentRunInput,
  StopAgentApprovalsInput,
  StopAgentApprovalsResult,
  SubagentRunRecord,
  TransitionAgentThreadSandboxInput,
} from "./types"
import { AGENT_RUN_FAILURE_CODES } from "./types"

function normalizeFailure(
  failure: SixbFailure<AgentRunFailureCode> | undefined
): SixbFailure<AgentRunFailureCode> | undefined {
  return failure ? parseSixbFailure(failure, AGENT_RUN_FAILURE_CODES) : undefined
}

function key(projectId: string, id: string): string {
  return JSON.stringify([projectId, id])
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
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
  readonly memory: Map<string, StoredAgentMemoryRepo>
  readonly approvals: Map<string, AgentApprovalRecord>
  /** By `[projectId, principal]` for a default, `[projectId, threadId, principal]` for a thread. */
  readonly approvalModes: Map<string, AgentApprovalMode>
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
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
  readonly memory: Map<string, StoredAgentMemoryRepo>
  readonly approvals: Map<string, AgentApprovalRecord>
  readonly approvalModes: Map<string, AgentApprovalMode>
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
      input.action === "recreate"
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
          thread.computer?.id === on.computerId &&
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
    return clone(participants)
  }

  async removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean> {
    const threadKey = key(input.projectId, input.threadId)
    const existing = this.state.participants.get(threadKey)
    const kept = existing?.filter((record) => record.principal.id !== input.principal.id)
    if (!existing || !kept || kept.length === existing.length) return false

    this.state.participants.set(threadKey, kept)
    return true
  }

  async assignComputer(input: AssignAgentThreadComputerInput): Promise<AgentThreadRecord> {
    assertAgentThreadComputer(input.computer)
    const threadKey = key(input.projectId, input.id)
    const thread = this.state.threads.get(threadKey) ?? null
    assertAssignableComputer(thread, input.id)

    const assigned: AgentThreadRecord = {
      ...thread,
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

    let queued: ConversationAgentRunRecord | undefined
    if (
      active?.kind === "conversation" &&
      active.status === "queued" &&
      active.spec?.runsOn === "computer"
    ) {
      queued = { ...active, spec: cloudSpec(active.spec) }
      this.state.runs.set(key(input.projectId, active.id), queued)
    }
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
    this.state.runs.set(runKey, clone(run))
    return clone(run)
  }

  async start(input: StartAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireStatus(input.projectId, input.id, "queued")
    if (input.onComputer) assertStartsOnComputer(run)
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
      runs.flatMap((run) =>
        run.kind === "conversation" && run.threadId === input.threadId ? [[run.id, run]] : []
      )
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
}

function nextMessageSeq(state: AgentStoreState, projectId: string, threadId: string): number {
  let max = 0
  for (const message of state.messages.values()) {
    if (message.projectId === projectId && message.threadId === threadId && message.seq > max) {
      max = message.seq
    }
  }
  return max + 1
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

  async hold(input: AgentComputerSessionRecord): Promise<void> {
    assertAgentComputerSession(input)
    this.sessions.set(sessionKey(input), clone(input))
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

export class InMemoryAgentStorage implements AgentStorage {
  private readonly state: AgentStoreState = {
    threads: new Map(),
    participants: new Map(),
    runs: new Map(),
    messages: new Map(),
    checkpoints: new Map(),
    memory: new Map(),
    approvals: new Map(),
    approvalModes: new Map(),
  }

  readonly threads: InMemoryAgentThreadStore
  readonly runs: InMemoryAgentRunStore
  readonly messages: InMemoryAgentMessageStore
  readonly checkpoints: InMemoryAgentContextCheckpointStore
  readonly memory: InMemoryAgentMemoryStore
  readonly approvals: InMemoryAgentApprovalStore
  readonly approvalModes: InMemoryAgentApprovalModeStore
  readonly computers = new InMemoryAgentComputerSessionStore()

  constructor(executions: ExecutionStorage) {
    this.threads = new InMemoryAgentThreadStore(this.state)
    this.runs = new InMemoryAgentRunStore(this.state, executions)
    this.messages = new InMemoryAgentMessageStore(this.state)
    this.checkpoints = new InMemoryAgentContextCheckpointStore(this.state)
    this.memory = new InMemoryAgentMemoryStore(this.state)
    this.approvals = new InMemoryAgentApprovalStore(this.state)
    this.approvalModes = new InMemoryAgentApprovalModeStore(this.state)
  }

  snapshot(): InMemoryAgentStorageSnapshot {
    return {
      threads: structuredClone(this.state.threads),
      participants: structuredClone(this.state.participants),
      runs: structuredClone(this.state.runs),
      messages: structuredClone(this.state.messages),
      checkpoints: structuredClone(this.state.checkpoints),
      memory: structuredClone(this.state.memory),
      approvals: structuredClone(this.state.approvals),
      approvalModes: structuredClone(this.state.approvalModes),
    }
  }

  restore(snapshot: InMemoryAgentStorageSnapshot): void {
    replace(this.state.threads, snapshot.threads)
    replace(this.state.participants, snapshot.participants)
    replace(this.state.runs, snapshot.runs)
    replace(this.state.messages, snapshot.messages)
    replace(this.state.checkpoints, snapshot.checkpoints)
    replace(this.state.memory, snapshot.memory)
    replace(this.state.approvals, snapshot.approvals)
    replace(this.state.approvalModes, snapshot.approvalModes)
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
