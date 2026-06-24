import type { SixbMessage, SixbMessagePart, SixbMessageRole } from "../../agents/message"
import type { Principal } from "../../auth"
import type { JsonValue } from "../../json"

// ── agent_threads — one conversation with an agent ──────────────────────────────────────────────

export type AgentThreadStatus = "active" | "archived"

export interface AgentThreadRecord {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  /** Who owns/opened the thread. Reuses the canonical auth principal (gains `agent` later for free). */
  readonly ownerPrincipal: Principal
  readonly title?: string
  readonly status: AgentThreadStatus
  /** Single-flight anchor: the id of the one run currently allowed to write, or `null` when idle. */
  readonly activeRunId: string | null
  readonly lastMessageAt?: Date
  readonly messageCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateAgentThreadInput {
  readonly id: string
  readonly projectId: string
  readonly agentId: string
  readonly ownerPrincipal: Principal
  readonly title?: string
  readonly status?: AgentThreadStatus
  readonly createdAt?: Date
  readonly updatedAt?: Date
}

export interface ListAgentThreadsInput {
  readonly projectId: string
  readonly agentId?: string
  readonly statuses?: readonly AgentThreadStatus[]
  readonly ownerPrincipal?: Principal
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAgentThreadsResult {
  readonly threads: readonly AgentThreadRecord[]
  readonly hasMore: boolean
  readonly total: number
}

// ── agent_runs — one loop execution (the worker job; attribution + lease anchor) ────────────────

export type AgentRunStatus = "running" | "succeeded" | "failed" | "cancelled"

export interface AgentRunUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly cachedInputTokens?: number
}

/** A worker's claim on a run: a unique lease id and an expiry the worker keeps renewing. */
export interface AgentRunLease {
  readonly id: string
  readonly expiresAt: Date
}

export interface AgentRunRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly agentId: string
  readonly triggerMessageId: string
  readonly status: AgentRunStatus
  readonly modelId?: string
  /** AI SDK `FinishReason`, stored as an opaque string (core does not depend on `ai`). */
  readonly finishReason?: string
  readonly usage?: AgentRunUsage
  /** Failure message when the run did not succeed. */
  readonly error?: string
  readonly attempt: number
  readonly lease?: AgentRunLease
  readonly createdAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
}

export interface ReserveAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly agentId: string
  readonly triggerMessageId: string
  readonly modelId?: string
  readonly lease: AgentRunLease
  readonly createdAt?: Date
  readonly startedAt?: Date
}

export interface RenewAgentRunLeaseInput {
  readonly id: string
  readonly projectId: string
  readonly leaseId: string
  readonly expiresAt: Date
}

export interface ReclaimAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly lease: AgentRunLease
  /** Compared against the current lease expiry; defaults to now. */
  readonly now?: Date
}

export type FinishAgentRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly leaseId: string
      readonly status: "succeeded"
      readonly modelId?: string
      readonly finishReason?: string
      readonly usage?: AgentRunUsage
      readonly completedAt?: Date
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly leaseId: string
      readonly status: "failed" | "cancelled"
      readonly modelId?: string
      readonly finishReason?: string
      readonly usage?: AgentRunUsage
      readonly error?: string
      readonly completedAt?: Date
    }

export interface ListAgentRunsInput {
  readonly projectId: string
  readonly threadId?: string
  readonly agentId?: string
  readonly statuses?: readonly AgentRunStatus[]
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAgentRunsResult {
  readonly runs: readonly AgentRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

// ── agent_messages — one message (assistant messages inserted only once finalized) ─────────────

export type AgentMessageRole = SixbMessageRole

export interface AgentMessageRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /** The run that produced this message; `null` for user-authored messages. */
  readonly runId: string | null
  readonly role: AgentMessageRole
  /** Monotonic per thread, assigned by the store. */
  readonly seq: number
  /** Structured message content — text / reasoning / step boundaries / tool calls. */
  readonly parts: readonly SixbMessagePart[]
  /** Message-level metadata (mirrors `UIMessage.metadata`). */
  readonly metadata?: JsonValue
  /** Versions the `parts` shape so it can be migrated; stamped from `SIXB_MESSAGE_CONTENT_VERSION`. */
  readonly contentVersion: number
  readonly createdAt: Date
  readonly completedAt?: Date
}

/** Append a message: a {@link SixbMessage} (role + parts + metadata) plus its storage identity. */
export interface AppendAgentMessageInput extends SixbMessage {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly runId: string | null
  readonly createdAt?: Date
  readonly completedAt?: Date
}

export interface ListAgentMessagesInput {
  readonly projectId: string
  readonly threadId: string
  readonly roles?: readonly AgentMessageRole[]
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAgentMessagesResult {
  readonly messages: readonly AgentMessageRecord[]
  readonly hasMore: boolean
  readonly total: number
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

export interface AgentThreadStore {
  create(input: CreateAgentThreadInput): Promise<AgentThreadRecord>
  getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null>
  list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult>
}

export interface AgentRunStore {
  /** Single-flight: atomically claims the thread's only active run and a lease. */
  reserve(input: ReserveAgentRunInput): Promise<AgentRunRecord>
  /** Heartbeat: bumps the lease expiry; throws `lease_lost` if the lease was reclaimed. */
  renewLease(input: RenewAgentRunLeaseInput): Promise<AgentRunRecord>
  /** Take over an expired lease (`attempt++`); throws `lease_not_expired` if still valid. */
  reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord>
  /** Finalize a run and release the thread's `activeRunId`. */
  finish(input: FinishAgentRunInput): Promise<AgentRunRecord>
  getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null>
  list(input: ListAgentRunsInput): Promise<ListAgentRunsResult>
}

export interface AgentMessageStore {
  /** Insert a message (its `parts` are the canonical content) and bump thread stats. */
  append(input: AppendAgentMessageInput): Promise<AgentMessageRecord>
  getById(params: { projectId: string; id: string }): Promise<AgentMessageRecord | null>
  list(input: ListAgentMessagesInput): Promise<ListAgentMessagesResult>
}

export interface AgentStorage {
  readonly threads: AgentThreadStore
  readonly runs: AgentRunStore
  readonly messages: AgentMessageStore
}
