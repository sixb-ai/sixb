import { MAIN_AGENT_ID } from "../../agents/main"
import { AGENT_MESSAGE_CONTENT_VERSION } from "../../agents/message"
import { principalsEqual } from "../../auth"
import { normalizeRequesterGroupIds } from "../../auth/attribution"
import { parseSixbFailure } from "../../errors/internal"
import type { SixbFailure } from "../../errors/types"
import type { ExecutionStorage } from "../executions"
import { AgentStorageError } from "./errors"
import {
  agentContextCheckpointMatchesCreateInput,
  assertAgentContextCheckpointAnchors,
  assertAgentContextCheckpointAuthority,
  assertAgentContextCheckpointReplayState,
  assertAgentRunExecution,
  assertCreateAgentContextCheckpointInput,
  assertCreateSubagentRunInput,
  assertSubagentRunResult,
  subagentRunMatchesCreateInput,
} from "./provider"
import type {
  AgentContextCheckpointRecord,
  AgentContextCheckpointStore,
  AgentMessageRecord,
  AgentMessageStore,
  AgentRunFailureCode,
  AgentRunRecord,
  AgentRunStore,
  AgentStorage,
  AgentThreadRecord,
  AgentThreadStore,
  AppendAgentMessageInput,
  ConfirmAgentRunExecutionOwnershipInput,
  ConversationAgentRunRecord,
  CreateAgentContextCheckpointInput,
  CreateAgentRunInput,
  CreateAgentThreadInput,
  CreateSubagentRunInput,
  DeleteAgentMessagesByRunInput,
  FinishAgentRunInput,
  FinishQueuedAgentRunInput,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ReclaimAgentRunInput,
  StartAgentRunInput,
  SubagentRunRecord,
} from "./types"
import { AGENT_RUN_FAILURE_CODES } from "./types"

function normalizeFailure(
  failure: SixbFailure<AgentRunFailureCode> | undefined
): SixbFailure<AgentRunFailureCode> | undefined {
  return failure ? parseSixbFailure(failure, AGENT_RUN_FAILURE_CODES) : undefined
}

function key(projectId: string, id: string): string {
  return `${projectId}:${id}`
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
 * Shared in-memory state behind the four sub-stores. They are tiered for ergonomics
 * (`storage.runs.create(...)`), but several operations span tables — creating/finishing a run
 * updates the thread anchor, appending a message bumps thread stats, and checkpoint creation reads
 * run/thread/message anchors — so they all read and write the same maps through this object.
 */
interface AgentStoreState {
  readonly threads: Map<string, AgentThreadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
}

export interface InMemoryAgentStorageSnapshot {
  readonly threads: Map<string, AgentThreadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
  readonly checkpoints: Map<string, AgentContextCheckpointRecord>
}

// ── threads ───────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentThreadStore implements AgentThreadStore {
  constructor(private readonly state: AgentStoreState) {}

  async create(input: CreateAgentThreadInput): Promise<AgentThreadRecord> {
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
      agentId: input.agentId,
      ownerPrincipal: clone(input.ownerPrincipal),
      ...(input.title === undefined ? {} : { title: input.title }),
      status: input.status ?? "active",
      activeRunId: null,
      messageCount: 0,
      createdAt,
      updatedAt: new Date(input.updatedAt ?? createdAt),
    }

    this.state.threads.set(threadKey, clone(record))
    return clone(record)
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null> {
    const record = this.state.threads.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult> {
    const order = input.order ?? "desc"
    const statuses = input.statuses ? new Set(input.statuses) : null
    const agentIds = input.agentIds ? new Set(input.agentIds) : null

    const filtered = [...this.state.threads.values()]
      .filter((thread) => thread.projectId === input.projectId)
      .filter((thread) => (input.agentId ? thread.agentId === input.agentId : true))
      .filter((thread) => (agentIds ? agentIds.has(thread.agentId) : true))
      .filter((thread) => (statuses ? statuses.has(thread.status) : true))
      .filter((thread) =>
        input.ownerPrincipal ? principalsEqual(thread.ownerPrincipal, input.ownerPrincipal) : true
      )
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
}

// ── runs ──────────────────────────────────────────────────────────────────────────────────────

class InMemoryAgentRunStore implements AgentRunStore {
  constructor(
    private readonly state: AgentStoreState,
    private readonly executions: ExecutionStorage
  ) {}

  async create(input: CreateAgentRunInput): Promise<ConversationAgentRunRecord> {
    await assertAgentRunExecution({
      executions: this.executions,
      projectId: input.projectId,
      executionId: input.executionId,
      runId: input.id,
      authority:
        input.agentId === MAIN_AGENT_ID
          ? { type: "inherited" }
          : { type: "managed", agentId: input.agentId },
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
    if (thread.activeRunId !== null) {
      throw new AgentStorageError(
        "active_run_exists",
        `[Sixb] Agent thread '${input.threadId}' already has an active run '${thread.activeRunId}'.`
      )
    }

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
      agentId: input.agentId,
      triggerMessageId: input.triggerMessageId,
      requesterGroupIds: normalizeRequesterGroupIds(input.requesterGroupIds),
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
      authority: { type: "inherited" },
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

    const run: SubagentRunRecord = {
      kind: "subagent",
      id: input.id,
      projectId: input.projectId,
      executionId: input.executionId,
      parentRunId: input.parentRunId,
      spawnKey: input.spawnKey,
      spec: clone(input.spec),
      requesterGroupIds: clone(parent.requesterGroupIds),
      status: "queued",
      attempt: 0,
      createdAt: new Date(input.createdAt ?? new Date()),
    }
    this.state.runs.set(runKey, clone(run))
    return clone(run)
  }

  async start(input: StartAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireStatus(input.projectId, input.id, "queued")
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

  async finish(input: FinishAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (!run.execution || run.execution.token !== input.executionToken) {
      throw new AgentStorageError(
        "execution_lost",
        `[Sixb] Execution token is no longer current on agent run '${input.id}'.`
      )
    }
    if (input.status === "succeeded" && run.kind === "subagent") {
      assertSubagentRunResult(input.result, run.id)
    }
    if (input.status === "succeeded" && run.kind === "conversation" && input.result !== undefined) {
      throw new AgentStorageError(
        "invalid_input",
        `[Sixb] Conversational Agent run '${run.id}' cannot persist a subagent result.`
      )
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

  async list(input: ListAgentRunsInput): Promise<ListAgentRunsResult> {
    const order = input.order ?? "desc"
    const statuses = input.statuses ? new Set(input.statuses) : null
    const kinds = input.kinds ? new Set(input.kinds) : null

    const filtered = [...this.state.runs.values()]
      .filter((run) => run.projectId === input.projectId)
      .filter((run) => (kinds ? kinds.has(run.kind) : true))
      .filter((run) =>
        input.threadId ? run.kind === "conversation" && run.threadId === input.threadId : true
      )
      .filter((run) =>
        input.agentId ? run.kind === "conversation" && run.agentId === input.agentId : true
      )
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

  private releaseThread(run: AgentRunRecord, completedAt: Date): void {
    if (run.kind !== "conversation") return
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
    const seq = this.nextSeq(input.projectId, input.threadId)
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
        messageCount: thread.messageCount + 1,
        lastMessageAt: createdAt,
        updatedAt: createdAt,
      })
    )

    return clone(message)
  }

  async deleteByRunId(input: DeleteAgentMessagesByRunInput): Promise<number> {
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
        messageCount: remainingMessages.length,
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

  private nextSeq(projectId: string, threadId: string): number {
    let max = 0
    for (const message of this.state.messages.values()) {
      if (message.projectId === projectId && message.threadId === threadId && message.seq > max) {
        max = message.seq
      }
    }
    return max + 1
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
    readonly runIds: readonly string[]
  }): Promise<readonly AgentContextCheckpointRecord[]> {
    const byRunId = new Map(
      [...this.state.checkpoints.values()]
        .filter((checkpoint) => checkpoint.projectId === input.projectId)
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
        .sort(
          (left, right) =>
            right.summarizedThroughSeq - left.summarizedThroughSeq ||
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id)
        )[0] ?? null
    )
  }
}

export class InMemoryAgentStorage implements AgentStorage {
  private readonly state: AgentStoreState = {
    threads: new Map(),
    runs: new Map(),
    messages: new Map(),
    checkpoints: new Map(),
  }

  readonly threads: InMemoryAgentThreadStore
  readonly runs: InMemoryAgentRunStore
  readonly messages: InMemoryAgentMessageStore
  readonly checkpoints: InMemoryAgentContextCheckpointStore

  constructor(executions: ExecutionStorage) {
    this.threads = new InMemoryAgentThreadStore(this.state)
    this.runs = new InMemoryAgentRunStore(this.state, executions)
    this.messages = new InMemoryAgentMessageStore(this.state)
    this.checkpoints = new InMemoryAgentContextCheckpointStore(this.state)
  }

  snapshot(): InMemoryAgentStorageSnapshot {
    return {
      threads: structuredClone(this.state.threads),
      runs: structuredClone(this.state.runs),
      messages: structuredClone(this.state.messages),
      checkpoints: structuredClone(this.state.checkpoints),
    }
  }

  restore(snapshot: InMemoryAgentStorageSnapshot): void {
    replace(this.state.threads, snapshot.threads)
    replace(this.state.runs, snapshot.runs)
    replace(this.state.messages, snapshot.messages)
    replace(this.state.checkpoints, snapshot.checkpoints)
  }
}

function replace<T>(target: Map<string, T>, source: Map<string, T>): void {
  target.clear()
  for (const [k, value] of structuredClone(source)) {
    target.set(k, value)
  }
}
