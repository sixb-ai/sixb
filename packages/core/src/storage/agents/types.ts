import type { AgentMessage, AgentMessagePart, AgentMessageRole } from "../../agents/message"
import type { Principal } from "../../auth"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
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

// ── agent_runs — one loop execution (the worker job; attribution + fencing) ───────────────────

/** Lifecycle shared by every durable agent execution, conversational or workflow-owned. */
export type AgentExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type AgentRunStatus = AgentExecutionStatus

/** Error codes an agent execution can persist and expose through its public contract. */
export const AGENT_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type AgentRunFailureCode = (typeof AGENT_RUN_FAILURE_CODES)[number]

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

/**
 * Closed on purpose, and the wire is closed with it.
 *
 * Sixb writes these codes and the generated client is what reads them, so an open union would only
 * be honest if the HTTP schema were open too — and that costs the OpenAPI enum, the client's
 * autocompletion, and Atlas's exhaustive `switch`. Sixb owns both ends, so a new code is a minor
 * version bump: cheap here, and a broken `switch` is better than a 500 from `z.enum`.
 */
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

/**
 * Authorization state for the current queue delivery.
 *
 * `queueLeaseExpiresAt` is a persisted projection of `ClaimedQueueJob.leaseExpiresAt`, not an
 * independently managed run lease. It may only be extended from a successful queue lease renewal.
 */
export interface AgentRunExecution {
  readonly token: string
  readonly queueLeaseExpiresAt: Date
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
  /** Portable failure snapshot when the run did not succeed. */
  readonly error?: SixbFailure<AgentRunFailureCode>
  /** Execution attempts: `0` while queued, `1` on first start, incremented on redelivery. */
  readonly attempt: number
  readonly execution?: AgentRunExecution
  readonly createdAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
}

export interface CreateAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly agentId: string
  readonly triggerMessageId: string
  readonly requestedByPrincipal: Principal
  readonly createdAt?: Date
}

export interface StartAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionPrincipal?: Extract<Principal, { readonly type: "serviceAccount" }>
  readonly modelId?: string
  readonly execution: AgentRunExecution
  readonly startedAt?: Date
}

export interface FinishQueuedAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly status: "failed" | "cancelled"
  readonly error?: SixbFailure<AgentRunFailureCode>
  readonly completedAt?: Date
}

export interface ReclaimAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly execution: AgentRunExecution
}

export interface ConfirmAgentRunExecutionOwnershipInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  /** Exact expiration returned by the queue claim or its latest successful renewal. */
  readonly queueLeaseExpiresAt: Date
}

export type FinishAgentRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken: string
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
      readonly executionToken: string
      readonly status: "failed" | "cancelled"
      readonly modelId?: string
      readonly finishReason?: AgentRunFinishReason
      readonly usage?: AgentRunUsage
      readonly diagnostics?: readonly AgentRunDiagnostic[]
      readonly error?: SixbFailure<AgentRunFailureCode>
      readonly completedAt?: Date
    }

export interface ListAgentRunsInput {
  readonly projectId: string
  readonly threadId?: string
  readonly agentId?: string
  readonly statuses?: readonly AgentRunStatus[]
  /** Effective start time; runs that never started use `createdAt`. */
  readonly startedAfter?: Date
  /** Effective start time; runs that never started use `createdAt`. */
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
  /** Persist a queued run and atomically claim the thread's single-flight slot. */
  create(input: CreateAgentRunInput): Promise<AgentRunRecord>
  /** Transition a queued run to running and install the first delivery's execution token. */
  start(input: StartAgentRunInput): Promise<AgentRunRecord>
  /** Finish a queued run before execution and release the thread's single-flight slot. */
  finishQueued(input: FinishQueuedAgentRunInput): Promise<AgentRunRecord>
  /** Rotate the execution token for a redelivered running job (`attempt++`). */
  reclaim(input: ReclaimAgentRunInput): Promise<AgentRunRecord>
  /**
   * Project the queue's latest confirmed ownership expiration onto the current execution.
   * Implementations must fence by token and must never move the expiration backwards.
   */
  confirmExecutionOwnership(input: ConfirmAgentRunExecutionOwnershipInput): Promise<AgentRunRecord>
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
