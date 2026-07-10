import type { AgentMessage, AgentMessagePart, AgentMessageRole } from "../../agents/message"
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
  /** Optional allowlist intersected with `agentId` when both are provided. Empty means no rows. */
  readonly agentIds?: readonly string[]
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

/**
 * Why a run ended — our own SDK-independent vocabulary (it mirrors the AI SDK unified finish
 * reasons), so reads are typed and exhaustive without core depending on `ai`. `other`/`unknown` are
 * catch-alls: a provider value we don't recognise still records *that* the run ended.
 */
export const AGENT_RUN_FINISH_REASONS = [
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
] as const

export type AgentRunFinishReason = (typeof AGENT_RUN_FINISH_REASONS)[number]

/**
 * Coerce an external finish-reason string — a DB column or an SDK value — to {@link
 * AgentRunFinishReason}. An unrecognised value becomes `"unknown"` rather than being dropped.
 */
export function coerceAgentRunFinishReason(
  value: string | null | undefined
): AgentRunFinishReason | undefined {
  if (value === null || value === undefined) {
    return undefined
  }
  return (AGENT_RUN_FINISH_REASONS as readonly string[]).includes(value)
    ? (value as AgentRunFinishReason)
    : "unknown"
}

export interface AgentRunUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly reasoningTokens?: number
  readonly cachedInputTokens?: number
}

/** Stable, user-facing diagnostics emitted by the platform while executing a run. */
export const AGENT_RUN_DIAGNOSTIC_CODES = [
  "output_file_limit_exceeded",
  "output_file_too_large",
  "output_budget_exhausted",
  "output_collection_failed",
  "output_file_changed",
  "output_storage_failed",
] as const

export type AgentRunDiagnosticCode = (typeof AGENT_RUN_DIAGNOSTIC_CODES)[number]
export type AgentRunDiagnosticSeverity = "warning" | "error"

export interface AgentRunDiagnostic {
  readonly code: AgentRunDiagnosticCode
  readonly severity: AgentRunDiagnosticSeverity
  readonly scope: "output"
  /** Relative path inside the run's published output directory, when one file is involved. */
  readonly path?: string
  /** Sanitized, stable copy suitable for display to an end user. */
  readonly message: string
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
  readonly requestedByPrincipal: Principal
  readonly executionPrincipal?: Extract<Principal, { readonly type: "serviceAccount" }>
  readonly status: AgentRunStatus
  readonly modelId?: string
  /** Why the run ended (our own SDK-independent enum). */
  readonly finishReason?: AgentRunFinishReason
  readonly usage?: AgentRunUsage
  /** Platform diagnostics are transcript annotations, never agent-authored message content. */
  readonly diagnostics?: readonly AgentRunDiagnostic[]
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
  readonly requestedByPrincipal: Principal
  readonly executionPrincipal?: Extract<Principal, { readonly type: "serviceAccount" }>
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
      readonly finishReason?: AgentRunFinishReason
      readonly usage?: AgentRunUsage
      readonly diagnostics?: readonly AgentRunDiagnostic[]
      readonly completedAt?: Date
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly leaseId: string
      readonly status: "failed" | "cancelled"
      readonly modelId?: string
      readonly finishReason?: AgentRunFinishReason
      readonly usage?: AgentRunUsage
      readonly diagnostics?: readonly AgentRunDiagnostic[]
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

export type { AgentMessageRole }

export interface AgentMessageRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /** The run that produced this message; `null` for user-authored messages. */
  readonly runId: string | null
  readonly role: AgentMessageRole
  /** Principal that authored this persisted message: caller for user messages, agent identity later for assistant messages. */
  readonly authorPrincipal?: Principal
  /** Monotonic per thread, assigned by the store. */
  readonly seq: number
  /** Structured message content — text / reasoning / step boundaries / tool calls. */
  readonly parts: readonly AgentMessagePart[]
  /** Message-level metadata (mirrors `UIMessage.metadata`). */
  readonly metadata?: JsonValue
  /** Versions the `parts` shape so it can be migrated; stamped from `AGENT_MESSAGE_CONTENT_VERSION`. */
  readonly contentVersion: number
  readonly createdAt: Date
  readonly completedAt?: Date
}

/** Append a message: a {@link AgentMessage} (role + parts + metadata) plus its storage identity. */
export interface AppendAgentMessageInput extends AgentMessage {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly runId: string | null
  readonly authorPrincipal?: Principal
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
  getByIds(params: {
    projectId: string
    ids: readonly string[]
  }): Promise<readonly AgentRunRecord[]>
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
