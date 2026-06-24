import { SIXB_MESSAGE_CONTENT_VERSION } from "../../agents/message"
import type { Principal } from "../../auth"
import { AgentStorageError } from "./errors"
import type {
  AgentMessageRecord,
  AgentMessageStore,
  AgentRunRecord,
  AgentRunStore,
  AgentStorage,
  AgentThreadRecord,
  AgentThreadStore,
  AppendAgentMessageInput,
  CreateAgentThreadInput,
  FinishAgentRunInput,
  ListAgentMessagesInput,
  ListAgentMessagesResult,
  ListAgentRunsInput,
  ListAgentRunsResult,
  ListAgentThreadsInput,
  ListAgentThreadsResult,
  ReclaimAgentRunInput,
  RenewAgentRunLeaseInput,
  ReserveAgentRunInput,
} from "./types"

function key(projectId: string, id: string): string {
  return `${projectId}:${id}`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function principalsEqual(a: Principal, b: Principal): boolean {
  return a.type === b.type && a.id === b.id
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
 * Shared in-memory state behind the three sub-stores. They are tiered for ergonomics
 * (`storage.runs.reserve(...)`), but several operations span tables — reserving/finishing a run
 * updates the thread anchor, appending a message bumps thread stats — so they all read and write the
 * same maps through this object.
 */
interface AgentStoreState {
  readonly threads: Map<string, AgentThreadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
}

export interface InMemoryAgentStorageSnapshot {
  readonly threads: Map<string, AgentThreadRecord>
  readonly runs: Map<string, AgentRunRecord>
  readonly messages: Map<string, AgentMessageRecord>
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

    const filtered = [...this.state.threads.values()]
      .filter((thread) => thread.projectId === input.projectId)
      .filter((thread) => (input.agentId ? thread.agentId === input.agentId : true))
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
  constructor(private readonly state: AgentStoreState) {}

  async reserve(input: ReserveAgentRunInput): Promise<AgentRunRecord> {
    // No `await` between read and write: the in-memory critical section is atomic, so two concurrent
    // reservations on the same thread cannot both win — the second observes `activeRunId` set.
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

    const createdAt = new Date(input.createdAt ?? new Date())
    const run: AgentRunRecord = {
      id: input.id,
      projectId: input.projectId,
      threadId: input.threadId,
      agentId: input.agentId,
      triggerMessageId: input.triggerMessageId,
      status: "running",
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      attempt: 1,
      lease: clone(input.lease),
      createdAt,
      startedAt: new Date(input.startedAt ?? createdAt),
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

  async renewLease(input: RenewAgentRunLeaseInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (!run.lease || run.lease.id !== input.leaseId) {
      throw new AgentStorageError(
        "lease_lost",
        `[Sixb] Lease '${input.leaseId}' is no longer held on agent run '${input.id}'.`
      )
    }

    const next: AgentRunRecord = {
      ...run,
      lease: { id: run.lease.id, expiresAt: new Date(input.expiresAt) },
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    const now = new Date(input.now ?? new Date())
    if (!run.lease) {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent run '${input.id}' has no lease to reclaim.`
      )
    }
    if (run.lease.expiresAt.getTime() > now.getTime()) {
      throw new AgentStorageError(
        "lease_not_expired",
        `[Sixb] Lease on agent run '${input.id}' has not expired yet.`
      )
    }

    const next: AgentRunRecord = {
      ...run,
      attempt: run.attempt + 1,
      lease: clone(input.lease),
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))
    return clone(next)
  }

  async finish(input: FinishAgentRunInput): Promise<AgentRunRecord> {
    const run = this.requireRunning(input.projectId, input.id)
    if (!run.lease || run.lease.id !== input.leaseId) {
      throw new AgentStorageError(
        "lease_lost",
        `[Sixb] Lease '${input.leaseId}' is no longer held on agent run '${input.id}'.`
      )
    }

    const completedAt = new Date(input.completedAt ?? new Date())
    const next: AgentRunRecord = {
      ...run,
      status: input.status,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
      ...(input.usage === undefined ? {} : { usage: clone(input.usage) }),
      ...(input.status === "succeeded" || input.error === undefined ? {} : { error: input.error }),
      lease: undefined,
      completedAt,
    }
    this.state.runs.set(key(input.projectId, input.id), clone(next))

    const threadKey = key(input.projectId, run.threadId)
    const thread = this.state.threads.get(threadKey)
    if (thread && thread.activeRunId === run.id) {
      this.state.threads.set(
        threadKey,
        clone({ ...thread, activeRunId: null, updatedAt: completedAt })
      )
    }

    return clone(next)
  }

  async getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null> {
    const record = this.state.runs.get(key(params.projectId, params.id))
    return record ? clone(record) : null
  }

  async list(input: ListAgentRunsInput): Promise<ListAgentRunsResult> {
    const order = input.order ?? "desc"
    const statuses = input.statuses ? new Set(input.statuses) : null

    const filtered = [...this.state.runs.values()]
      .filter((run) => run.projectId === input.projectId)
      .filter((run) => (input.threadId ? run.threadId === input.threadId : true))
      .filter((run) => (input.agentId ? run.agentId === input.agentId : true))
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
    const run = this.state.runs.get(key(projectId, id))
    if (!run) {
      throw new AgentStorageError(
        "run_not_found",
        `[Sixb] Agent run '${id}' not found for project '${projectId}'.`
      )
    }
    if (run.status !== "running") {
      throw new AgentStorageError(
        "invalid_state",
        `[Sixb] Agent run '${id}' is not running (status '${run.status}').`
      )
    }
    return run
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
      seq,
      parts: clone(input.parts),
      ...(input.metadata === undefined ? {} : { metadata: clone(input.metadata) }),
      contentVersion: SIXB_MESSAGE_CONTENT_VERSION,
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

export class InMemoryAgentStorage implements AgentStorage {
  private readonly state: AgentStoreState = {
    threads: new Map(),
    runs: new Map(),
    messages: new Map(),
  }

  readonly threads = new InMemoryAgentThreadStore(this.state)
  readonly runs = new InMemoryAgentRunStore(this.state)
  readonly messages = new InMemoryAgentMessageStore(this.state)

  snapshot(): InMemoryAgentStorageSnapshot {
    return {
      threads: structuredClone(this.state.threads),
      runs: structuredClone(this.state.runs),
      messages: structuredClone(this.state.messages),
    }
  }

  restore(snapshot: InMemoryAgentStorageSnapshot): void {
    replace(this.state.threads, snapshot.threads)
    replace(this.state.runs, snapshot.runs)
    replace(this.state.messages, snapshot.messages)
  }
}

function replace<T>(target: Map<string, T>, source: Map<string, T>): void {
  target.clear()
  for (const [k, value] of structuredClone(source)) {
    target.set(k, value)
  }
}
