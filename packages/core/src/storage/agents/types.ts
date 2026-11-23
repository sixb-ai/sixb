import type { ActionSubject } from "../../actions/types"
import type { AgentMessage, AgentMessagePart, AgentMessageRole } from "../../agents/message"
import type { AgentReasoning } from "../../agents/types"
import type { Principal, UserPrincipal } from "../../auth"
import type { FileRef } from "../../blob-storage/types"
import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { JsonObject, JsonValue } from "../../json"
import type {
  LanguageModelRef,
  LanguageModelTier,
  LanguageModelTierProbabilities,
} from "../../models"
import type { ActionRunFailure, ActionRunParams } from "../action-runs/types"

// ── agent_threads — one conversation with an agent ──────────────────────────────────────────────

export type AgentThreadStatus = "active" | "archived"

/** Immutable, non-secret application input. Never store resolved env or credentials here. */
export type AgentThreadSandboxParams = Readonly<Record<string, JsonValue>>

/** Worker-owned state, independent from the immutable application binding. */
export interface AgentThreadSandboxState {
  /** Exact name passed to the provider. Replacements always receive a fresh name. */
  readonly name: string
  readonly status: "new" | "busy" | "ready" | "blocked" | "unavailable"
  readonly sourceFingerprint?: string
  readonly initialized: boolean
  /** Durable context boundary: local files from before this reset are no longer available. */
  readonly resetAt?: string
  /** Never expires automatically: a delayed provider operation must not reach a successor. */
  readonly owner?: { readonly runId: string; readonly executionToken: string }
}

export type TransitionAgentThreadSandboxInput = {
  readonly projectId: string
  readonly id: string
} & (
  | {
      readonly action: "acquire"
      readonly runId: string
      readonly executionToken: string
      readonly name: string
      readonly sourceFingerprint: string
    }
  | {
      readonly action: "replace"
      readonly runId: string
      readonly executionToken: string
      readonly name: string
      readonly nextName: string
    }
  | {
      readonly action: "settle"
      readonly runId: string
      readonly executionToken: string
      readonly name: string
      readonly status: "ready" | "blocked" | "unavailable"
      readonly initialized: boolean
    }
  | {
      readonly action: "recreate"
      readonly expectedSandboxName: string
      readonly name: string
    }
  | {
      /** Go on in the sandbox a failed save left, as its owner chose: the one named `name`. */
      readonly action: "restore"
      readonly name: string
    }
)

/**
 * A conversation, or the thread a sub-agent works in. A sub-agent's thread is never listed, and
 * whoever reads its conversation reads it.
 */
export type AgentThreadKind = "conversation" | "subagent"

/** Where a sub-agent's thread comes from: its conversation, the turn that spawned it, and its key. */
export interface AgentThreadParent {
  readonly threadId: string
  /** The turn that spawned it. Its later runs work under the turns that go on with it. */
  readonly spawnedBy: string
  readonly key: string
}

/** The computer a thread runs on, and the folder there its turns work in. */
export interface AgentThreadComputer {
  /** The CLI's id for the computer: a thread's turns are claimed by that computer alone. */
  readonly id: string
  /** What its owner calls the computer, such as "Anthony's MacBook Pro". */
  readonly name: string
  /** The absolute path its turns work in, on that computer. */
  readonly folder: string
}

/** Where a thread runs: which of its owner's computers, and the folder there. */
export type AgentThreadPlace = Pick<AgentThreadComputer, "id" | "folder">

export interface AgentThreadRecord {
  readonly id: string
  readonly projectId: string
  readonly kind: AgentThreadKind
  /** Set exactly on a sub-agent's thread. */
  readonly parent?: AgentThreadParent
  /** Who owns/opened the thread. Reuses the canonical auth principal (gains `agent` later for free). */
  readonly ownerPrincipal: Principal
  readonly title?: string
  readonly sandboxParams?: AgentThreadSandboxParams
  readonly sandboxState?: AgentThreadSandboxState
  /**
   * Where its turns run: on its owner's computer, which claims them, or, when absent, in the cloud.
   * A computer's thread takes turns from its owner alone.
   */
  readonly runsOn?: "computer"
  /**
   * Where on its owner's computers a computer's thread runs: set when it is created, and when its
   * owner moves it. Only that computer, open in that folder, claims its turns. A computer's thread
   * created before folders were kept has none until its owner moves it.
   */
  readonly computer?: AgentThreadComputer
  /**
   * When its turns last moved to where they run now, from a computer to the cloud or between
   * folders: the files earlier turns worked on are not here.
   */
  readonly movedAt?: Date
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
  readonly ownerPrincipal: Principal
  readonly title?: string
  readonly sandboxParams?: AgentThreadSandboxParams
  readonly runsOn?: "computer"
  /** Where a computer's thread runs: required with `runsOn: "computer"`, refused without it. */
  readonly computer?: AgentThreadComputer
  readonly status?: AgentThreadStatus
  readonly createdAt?: Date
  readonly updatedAt?: Date
}

/**
 * A new thread holding a copy of another thread's finished messages. A turn still running is left
 * behind: what came from its trigger message on is not copied. Copies keep their `seq`, content,
 * author and `runId`, and get new ids. Runs are not copied, so the fork's runs, usage and cost are
 * its own; copied answers still show their run's diagnostics.
 *
 * Only the latest checkpoint the copy can use comes along, so the markers of earlier compactions
 * are not in the fork. The fork has no `lastMessageAt` until its first new message, so it sorts
 * by its creation.
 */
export interface ForkAgentThreadInput {
  readonly projectId: string
  /** The thread whose history is copied. */
  readonly sourceThreadId: string
  readonly id: string
  readonly ownerPrincipal: Principal
  readonly title?: string
  readonly sandboxParams?: AgentThreadSandboxParams
  /** Provider name of the fork's new sandbox; given exactly when `sandboxParams` is. */
  readonly sandboxName?: string
  /**
   * The source's shared artifacts, each id mapped to its copy's: the copied messages and summary
   * name the copies instead.
   */
  readonly artifactCopies?: Readonly<Record<string, string>>
  readonly createdAt?: Date
}

/** A conversation's sub-agent threads, oldest first. */
export interface ListAgentThreadChildrenInput {
  readonly projectId: string
  /** The conversation. */
  readonly parentThreadId: string
  /** Only those this turn spawned. */
  readonly parentRunId?: string
  /** At most this many, 100 by default. */
  readonly limit?: number
  readonly offset?: number
}

/** Conversations only: a sub-agent's thread is read through its conversation. */
export interface ListAgentThreadsInput {
  readonly projectId: string
  readonly statuses?: readonly AgentThreadStatus[]
  readonly ownerPrincipal?: Principal
  /** Only the threads this user takes part in. */
  readonly participantPrincipal?: UserPrincipal
  /** Only the threads that run on this computer, in this folder, with a turn active. */
  readonly activeOnComputer?: AgentThreadPlace
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListAgentThreadsResult {
  readonly threads: readonly AgentThreadRecord[]
  readonly hasMore: boolean
  readonly total: number
}

// ── agent_thread_participants — the users a thread's owner added to it ─────────────────────────

export interface AgentThreadParticipantRecord {
  readonly projectId: string
  readonly threadId: string
  readonly principal: UserPrincipal
  readonly addedAt: Date
  readonly addedBy: Principal
}

export interface AddAgentThreadParticipantsInput {
  readonly projectId: string
  readonly threadId: string
  /**
   * Distinct users, checked by the caller. Someone already taking part keeps when and by whom they
   * were first added.
   */
  readonly principals: readonly UserPrincipal[]
  readonly addedBy: Principal
  /** Refused with `participant_limit`, adding no one, when the thread would hold more. */
  readonly maxParticipants: number
  readonly addedAt?: Date
}

export interface AssignAgentThreadComputerInput {
  readonly projectId: string
  readonly id: string
  /** Where the thread's turns run from now on. */
  readonly computer: AgentThreadComputer
  /** Its `movedAt` when this changes the computer or folder of a thread that had one. */
  readonly movedAt?: Date
}

export interface MoveAgentThreadToCloudInput {
  readonly projectId: string
  readonly id: string
  readonly movedAt?: Date
}

/** A computer's thread, now in the cloud, and its queued turn, now the cloud's to run. */
export interface MoveAgentThreadToCloudResult {
  readonly thread: AgentThreadRecord
  readonly queued?: ConversationAgentRunRecord
}

/**
 * An open `sixb` on its owner's computer: while it is live, the threads that run on that computer
 * in its folder are reachable there. It ends when `sixb` closes, or lapses when it stops renewing.
 */
export interface AgentComputerSessionRecord {
  readonly projectId: string
  /** Chosen by the computer, once per open `sixb`; unique among its owner's sessions. */
  readonly id: string
  readonly ownerPrincipal: Principal
  readonly computer: AgentThreadComputer
  readonly expiresAt: Date
  /** Its threads' background commands, as its latest renewal reported them. */
  readonly backgroundCommands?: readonly AgentComputerBackgroundCommand[]
  /** The commands someone asked to stop: each renewal hands back those still running. */
  readonly stopRequests?: readonly AgentBackgroundCommandRef[]
}

/** How many background commands a computer session reports, and keeps stop requests for. */
export const AGENT_COMPUTER_BACKGROUND_COMMANDS_MAX = 64

/**
 * A background command an open `sixb` runs for one of its threads, which outlives the turn that
 * started it: the web shows how it stands between turns.
 */
export interface AgentComputerBackgroundCommand {
  readonly threadId: string
  /** `bg_<hex>`, as the agent's tools name it. */
  readonly id: string
  readonly command: string
  readonly status: "running" | "exited" | "stopped"
  readonly exitCode?: number
  /** ISO timestamps. */
  readonly startedAt: string
  readonly endedAt?: string
}

/** A background command by its start: its id comes again once `sixb` restarts. */
export interface AgentBackgroundCommandRef {
  readonly threadId: string
  readonly id: string
  readonly startedAt: string
}

export interface RemoveAgentThreadParticipantInput {
  readonly projectId: string
  readonly threadId: string
  readonly principal: UserPrincipal
}

export interface ListAgentThreadParticipantsInput {
  readonly projectId: string
  readonly threadIds: readonly string[]
}

// ── agent_thread_reads — how far each person has read a conversation ──────────────────────────

/**
 * How far one person's reading of a conversation has reached, as the `seq` of its last message.
 *
 * A watermark, not a flag: nothing writes here when a message arrives, so new ones sit past it
 * until the reader moves it. A mark never moves it backwards, so two devices converge on the later
 * position and a stale one cannot rewind the other. Only a deletion does: when a retry or an edit
 * takes the newest messages away, every place past what remains comes back to it, because the next
 * messages take those numbers again.
 */
export interface AgentThreadReadRecord {
  readonly projectId: string
  readonly threadId: string
  readonly principal: UserPrincipal
  /** The highest message `seq` this person's reading has reached. 0 when none has. */
  readonly throughSeq: number
  /** When this person last looked: every mark sets it, even one that leaves `throughSeq` alone. */
  readonly readAt: Date
}

/**
 * One person's place in a conversation, and what arrived past it.
 *
 * `unread` counts the messages past `throughSeq` that are new to them: every Agent answer and
 * every other person's message. What they wrote is not, nor a message that only reports how
 * approved calls ended (`countsAsThreadMessage`).
 */
export interface AgentThreadReadState {
  readonly threadId: string
  /** Where their reading reached, never past `headSeq`. 0 when they have no row. */
  readonly throughSeq: number
  /** The `seq` of the thread's newest message, 0 when it has none. */
  readonly headSeq: number
  /** Messages past `throughSeq` that someone else wrote. */
  readonly unread: number
  /** When they last looked; absent until they have a row. */
  readonly readAt?: Date
}

export interface MarkAgentThreadReadInput {
  readonly projectId: string
  readonly threadId: string
  readonly principal: UserPrincipal
  /**
   * The last message they read, or the thread's newest when absent. A message the thread no longer
   * holds marks nothing: a retry or an edit took it away, and its number may already name another.
   */
  readonly throughMessageId?: string
  readonly readAt?: Date
}

export interface ListAgentThreadReadsInput {
  readonly projectId: string
  readonly threadIds: readonly string[]
  readonly principal: UserPrincipal
}

export interface AgentThreadReadStore {
  /**
   * Record that this person's reading reached a message, never moving it back, and that they
   * looked now. A participant has a row from the moment they join, and the migration gave one to
   * everyone in the threads that existed before; an owner without one reads as 0 until their
   * first mark. Answers their place afterwards.
   */
  mark(input: MarkAgentThreadReadInput): Promise<AgentThreadReadState>
  /** One person's place in each of these threads; a thread that does not exist is absent. */
  list(input: ListAgentThreadReadsInput): Promise<readonly AgentThreadReadState[]>
}

// ── agent_runs — one loop execution (the worker job; attribution + fencing) ───────────────────

/** Lifecycle shared by every durable agent execution, conversational or workflow-owned. */
export type AgentExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export type AgentRunStatus = AgentExecutionStatus
export type AgentRunKind = "conversation" | "subagent"

/** Error codes an agent execution can persist and expose through its public contract. */
export const AGENT_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "runtime.cancelled",
  "agent.context_limit_exceeded",
  "agent.execution_failed",
  "agent.step_limit_reached",
  "ai.usage_limit_exceeded",
  "ai.usage_limit_unavailable",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type AgentRunFailureCode = (typeof AGENT_RUN_FAILURE_CODES)[number]

/**
 * Why a run ended — Sixb's provider-independent vocabulary. It includes model-loop reasons plus
 * platform-level endings such as `timeout`, `interrupted` for a turn whose worker died before
 * finishing it, `awaiting_approval` for a succeeded turn that paused on calls waiting for its
 * requester, or `awaiting_answer` for a succeeded sub-agent that paused on a question its parent
 * answers in a later turn, so reads remain typed and exhaustive. `other` and `unknown` preserve terminal state
 * when a provider adds a new reason.
 */
export const AGENT_RUN_FINISH_REASONS = [
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "timeout",
  "interrupted",
  "awaiting_approval",
  "awaiting_answer",
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

/** Stable, user-facing diagnostics emitted by the platform while executing a run. */
export const AGENT_RUN_DIAGNOSTIC_CODES = [
  "step_limit_reached",
  "output_limit_reached",
  "workspace_not_saved",
] as const

/**
 * Closed on purpose, and the wire is closed with it.
 *
 * Sixb writes these codes and the generated client is what reads them, so an open union would only
 * be honest if the HTTP schema were open too — and that costs the OpenAPI enum, the client's
 * autocompletion, and the app's exhaustive `switch`. Sixb owns both ends, so a new code is a minor
 * version bump: cheap here, and a broken `switch` is better than a 500 from `z.enum`.
 */
export type AgentRunDiagnosticCode = (typeof AGENT_RUN_DIAGNOSTIC_CODES)[number]
export type AgentRunDiagnosticSeverity = "warning" | "error"

export interface AgentRunDiagnostic {
  readonly code: AgentRunDiagnosticCode
  readonly severity: AgentRunDiagnosticSeverity
  /** What the diagnostic is about: the turn as a whole. */
  readonly scope: "run"
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

interface AgentRunRecordBase {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly status: AgentRunStatus
  readonly modelId?: string
  /** Why the run ended (our own SDK-independent enum). */
  readonly finishReason?: AgentRunFinishReason
  /** Platform diagnostics are transcript annotations, never agent-authored message content. */
  readonly diagnostics?: readonly AgentRunDiagnostic[]
  /** Portable failure snapshot when the run did not succeed. */
  readonly error?: SixbFailure<AgentRunFailureCode>
  /** Execution attempts: `0` while queued, `1` on first start, incremented on redelivery. */
  readonly attempt: number
  readonly execution?: AgentRunExecution
  /**
   * When someone asked a running run to stop. Its run token stops working at once, and its runner
   * learns of it at its next lease renewal if the broker's cancel never reached it.
   */
  readonly cancelRequestedAt?: Date
  readonly createdAt: Date
  readonly startedAt?: Date
  readonly completedAt?: Date
}

export interface ConversationAgentRunRecord extends AgentRunRecordBase {
  readonly kind: "conversation"
  readonly threadId: string
  readonly triggerMessageId: string
  /** Immutable model selection captured at admission. Absent only on runs predating this field. */
  readonly spec?: ConversationAgentRunSpec
}

/** Immutable, serialisable model selection and requester settings for one conversational turn. */
export interface ConversationAgentRunSpec {
  readonly model: LanguageModelRef
  /** With tiers, the tier of the model the turn runs on. */
  readonly tier?: LanguageModelTier
  /**
   * How likely the decision model judged each tier, when Sixb picked the turn's model. Kept to
   * calibrate the thresholds the tier is picked from (`heavy` from 0.4, `light` from 0.8).
   */
  readonly tierProbabilities?: LanguageModelTierProbabilities
  readonly reasoning?: AgentReasoning
  /** Canonical IANA time zone of the requester. Absent uses the project time zone. */
  readonly timeZone?: string
  /** Canonical BCP 47 language of the requester. Absent uses the project locale. */
  readonly locale?: string
  /** What the turn may change without asking its requester. Absent on older runs: `auto`. */
  readonly approvalMode?: AgentApprovalMode
  /** Its thread's `runsOn` when it was asked for: a computer's turn never reaches the agent queue. */
  readonly runsOn?: "computer"
  /**
   * Which computer and folder the turn ran in: captured with `runsOn: "computer"` and updated if a
   * queued turn moves to another folder before starting.
   */
  readonly computer?: AgentThreadPlace
}

/** Immutable, serialisable child configuration captured before dispatch. */
export interface SubagentRunSpec {
  readonly model: LanguageModelRef
  /** With tiers, the tier of the model the child runs on. Absent on children admitted before it. */
  readonly tier?: LanguageModelTier
  readonly reasoning?: AgentReasoning
  /** Focused task supplied by the parent Agent. */
  readonly task: string
  /** At most this many steps per run, as its parent asked: the project's limit still applies. */
  readonly maxSteps?: number
  /** Project tools available when the child was admitted. Runtime tools are injected separately. */
  readonly toolNames: readonly string[]
  /** The parent turn's mode, copied when the child was admitted. Absent: `auto`. */
  readonly approvalMode?: AgentApprovalMode
  /** The parent turn's requester settings. Absent uses the project's. */
  readonly timeZone?: string
  readonly locale?: string
  /** Files the parent handed over, copied into the child's sandbox at these paths. */
  readonly files?: readonly SubagentRunFile[]
  /**
   * The child leaves the files as it found them, for a review or an investigation: it has no
   * `edit` and no `write` tool. Absent: it has both.
   */
  readonly readOnly?: true
  /**
   * The child's thread works in its parent's workspace, as the turn that spawned it lent it: its
   * runs keep their files under its thread's own directory there, and a continuation goes on in
   * the workspace while its turn lends it and the conversation did not move, else in a blank
   * sandbox of its own, with the same run files directory. Absent: a sandbox of its own, which its
   * continuations keep.
   */
  readonly inParentWorkspace?: true
}

/** A file a parent and its child hand each other, stored once and copied into a sandbox. */
export interface SubagentRunFile {
  /** Relative, `/`-separated, without `.` or `..` segments. */
  readonly path: string
  readonly fileRef: FileRef
}

/** Durable child output returned to its parent by `wait`. */
export interface SubagentRunResult {
  /** Empty only for a child that paused on its held calls before it answered. */
  readonly text: string
  /** What the child wrote under `out/`, by path relative to it. */
  readonly files?: readonly SubagentRunFile[]
  /** Why none of what it wrote under `out/` came back, and what to do about it. */
  readonly filesError?: string
  /**
   * What its parent sent a paused child that it had not read: the run that continues it reads it
   * first.
   */
  readonly unread?: readonly { readonly id: string; readonly text: string }[]
}

export interface SubagentRunRecord extends AgentRunRecordBase {
  readonly kind: "subagent"
  /** The child's own thread, which holds its task and its work. */
  readonly threadId: string
  /** The message of its thread that started the run. */
  readonly triggerMessageId: string
  /** The conversation turn the child runs under: its mode and cancellation. */
  readonly parentRunId: string
  /** Stable parent-selected key that makes repeated tool execution idempotent. */
  readonly spawnKey: string
  readonly spec: SubagentRunSpec
  readonly result?: SubagentRunResult
}

export type AgentRunRecord = ConversationAgentRunRecord | SubagentRunRecord

export interface CreateAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly threadId: string
  readonly triggerMessageId: string
  readonly spec: ConversationAgentRunSpec
  readonly createdAt?: Date
}

export interface CreateSubagentRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly parentRunId: string
  /** Current parent delivery token. New children are admitted only while that delivery owns it. */
  readonly parentExecutionToken: string
  readonly spawnKey: string
  readonly spec: SubagentRunSpec
  /**
   * The child's thread. Its first run creates it, owned by the conversation's owner; a later run
   * goes into it, and is refused while another run of the thread is active.
   */
  readonly thread: { readonly id: string; readonly create: boolean }
  /** The user message that starts the run, appended to the child's thread with the run's id. */
  readonly trigger: Pick<AppendAgentMessageInput, "id" | "parts" | "metadata">
  /** Internal safety bound enforced atomically across worker processes. */
  readonly maxActiveChildren: number
  readonly createdAt?: Date
}

export interface StartAgentRunInput {
  readonly id: string
  readonly projectId: string
  readonly modelId?: string
  readonly execution: AgentRunExecution
  readonly startedAt?: Date
  /**
   * Start it only as a computer's turn, there and in that folder: one whose thread moved meanwhile
   * is refused with `invalid_state`, so it never starts where its thread no longer runs.
   */
  readonly onComputer?: AgentThreadPlace
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
  /**
   * Take the run over only if the lease last recorded on it ran out by then, checked in the same
   * write: a renewal that lands first keeps it its runner's. Otherwise `invalid_state`.
   */
  readonly ifLapsedBy?: Date
}

export interface ConfirmAgentRunExecutionOwnershipInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  /** Exact expiration returned by the queue claim or its latest successful renewal. */
  readonly queueLeaseExpiresAt: Date
}

export interface RequestAgentRunCancelInput {
  readonly id: string
  readonly projectId: string
  readonly at?: Date
}

export type FinishAgentRunInput =
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken: string
      readonly status: "succeeded"
      readonly modelId?: string
      readonly finishReason?: AgentRunFinishReason
      readonly diagnostics?: readonly AgentRunDiagnostic[]
      readonly result?: SubagentRunResult
      readonly completedAt?: Date
    }
  | {
      readonly id: string
      readonly projectId: string
      readonly executionToken: string
      readonly status: "failed" | "cancelled"
      readonly modelId?: string
      /** Only a succeeded run pauses. */
      readonly finishReason?: Exclude<AgentRunFinishReason, "awaiting_approval" | "awaiting_answer">
      readonly diagnostics?: readonly AgentRunDiagnostic[]
      readonly error?: SixbFailure<AgentRunFailureCode>
      readonly completedAt?: Date
    }

export interface ListAgentRunsInput {
  readonly projectId: string
  readonly kinds?: readonly AgentRunKind[]
  readonly threadId?: string
  readonly parentRunId?: string
  readonly statuses?: readonly AgentRunStatus[]
  /** Effective start time; runs that never started use `createdAt`. */
  readonly startedAfter?: Date
  /** Effective start time; runs that never started use `createdAt`. */
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
  /** Leave out the turns that wait for a computer: only a worker's to run. */
  readonly excludeComputerTurns?: boolean
}

export interface ListThreadSubagentsInput {
  readonly projectId: string
  /** The conversation whose turns spawned them. */
  readonly threadId: string
  readonly spawnKey?: string
  readonly finishReason?: AgentRunFinishReason
  /** Only children spawned by turns whose trigger message is still in the thread. */
  readonly retainedTurnsOnly?: boolean
  /** At most this many, 100 by default. */
  readonly limit?: number
}

export interface ListAgentRunsResult {
  readonly runs: readonly AgentRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface ListLatestAgentRunsInput {
  readonly projectId: string
  readonly threadIds: readonly string[]
}

// ── agent_messages — one message (assistant messages inserted only once finalized) ─────────────

export type { AgentMessageRole }

export interface AgentMessageRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /**
   * The run that produced this message; `null` for user-authored messages. In a sub-agent's thread
   * every message has one, its trigger too, so a run's messages are deleted whole. A message copied
   * by a fork keeps the run that produced it, which belongs to the thread it was copied from.
   */
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

export interface DeleteAgentMessagesFromSeqInput {
  readonly projectId: string
  readonly threadId: string
  /** Delete every message whose per-thread sequence is greater than or equal to this boundary. */
  readonly fromSeq: number
}

export interface DeleteAgentMessagesByRunInput {
  readonly projectId: string
  readonly threadId: string
  readonly runId: string
  /**
   * The run that deletes them, when one does: refused with `execution_lost` unless it still runs
   * under this token, checked in the same transaction as the delete.
   */
  readonly fence?: { readonly runId: string; readonly executionToken: string }
}

export interface ListAgentMessagesInput {
  readonly projectId: string
  readonly threadId: string
  /** Return only messages whose per-thread sequence is greater than this retained boundary. */
  readonly afterSeq?: number
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

export interface ListAgentThreadIdsByArtifactContextInput {
  readonly projectId: string
  /** The artifact a user message carries as context, as `agentContext.artifact()` sends it. */
  readonly artifactId: string
  /** Only the conversations this principal owns or takes part in; every thread without it. */
  readonly reader?: Principal
}

// ── agent_context_checkpoints — append-only model-context boundaries ──────────────────────────

export type AgentContextCheckpointReason = "threshold" | "overflow"

/**
 * A durable summary boundary used only when projecting a thread into model context.
 *
 * Checkpoints never replace or mutate transcript messages. Normal thread reads remain authoritative
 * and complete; the worker reads the latest checkpoint and only the retained message tail.
 */
export interface AgentContextCheckpointRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /** A fork's copy keeps the run that wrote the summary, in the thread it was copied from. */
  readonly createdByRunId: string
  readonly previousCheckpointId?: string
  readonly reason: AgentContextCheckpointReason
  readonly summary: string
  readonly summaryFormatVersion: 1
  readonly summarizedThroughSeq: number
  readonly observedHeadSeq: number
  readonly estimatedInputTokensBefore: number
  readonly estimatedInputTokensAfter: number
  readonly summaryModelId: string
  readonly createdAt: Date
}

export interface CreateAgentContextCheckpointInput {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly createdByRunId: string
  /** Compare-and-swap anchor. `null` means the thread must not have a prior checkpoint. */
  readonly expectedPreviousCheckpointId: string | null
  /** Compare-and-swap anchor for the complete transcript observed by the summarizer. */
  readonly expectedHeadSeq: number
  /** Current delivery token for `createdByRunId`; stale redeliveries must not write. */
  readonly executionToken: string
  readonly reason: AgentContextCheckpointReason
  readonly summary: string
  readonly summaryFormatVersion: 1
  readonly summarizedThroughSeq: number
  readonly observedHeadSeq: number
  readonly estimatedInputTokensBefore: number
  readonly estimatedInputTokensAfter: number
  readonly summaryModelId: string
  readonly createdAt?: Date
}

// ── Store ───────────────────────────────────────────────────────────────────────────────────────

export interface AgentThreadStore {
  /** Atomic run-fenced transition, or explicit idle-thread recreation. */
  transitionSandbox(input: TransitionAgentThreadSandboxInput): Promise<AgentThreadSandboxState>
  create(input: CreateAgentThreadInput): Promise<AgentThreadRecord>
  /**
   * Create a thread holding a copy of another's finished history, in one transaction. The source's
   * sub-agent threads are not copied, and a sub-agent's thread is refused.
   */
  fork(input: ForkAgentThreadInput): Promise<AgentThreadRecord>
  getById(params: { projectId: string; id: string }): Promise<AgentThreadRecord | null>
  /** The threads found, in first-occurrence input order; a missing one is omitted. */
  getByIds(params: {
    readonly projectId: string
    readonly ids: readonly string[]
  }): Promise<readonly AgentThreadRecord[]>
  list(input: ListAgentThreadsInput): Promise<ListAgentThreadsResult>
  /** The sub-agents' threads of a conversation, by creation and id, all of them or one turn's. */
  listChildren(input: ListAgentThreadChildrenInput): Promise<readonly AgentThreadRecord[]>
  /**
   * Add users atomically and return every participant of the thread afterwards. A sub-agent's
   * thread has none: its readers are its conversation's.
   */
  addParticipants(
    input: AddAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]>
  /** Whether the user took part until now. */
  removeParticipant(input: RemoveAgentThreadParticipantInput): Promise<boolean>
  /**
   * Move a conversation thread to a computer and folder, from the cloud or from another computer or
   * folder, and return the thread after. Refused while a turn holds a cloud thread or runs on its
   * computer.
   */
  assignComputer(input: AssignAgentThreadComputerInput): Promise<AgentThreadRecord>
  /**
   * Move a computer's thread to the cloud, in one transaction with its queued turn, which the cloud
   * runs instead. Refused with `active_run_exists` while a turn runs on the computer, and
   * `invalid_input` for a thread already in the cloud.
   */
  moveToCloud(input: MoveAgentThreadToCloudInput): Promise<MoveAgentThreadToCloudResult>
  /** The participants of these threads, oldest first, then by user id and thread id. */
  listParticipants(
    input: ListAgentThreadParticipantsInput
  ): Promise<readonly AgentThreadParticipantRecord[]>
}

export interface AgentRunStore {
  /**
   * Persist a queued turn and atomically claim the thread's single-flight slot. A sub-agent's
   * thread takes only child runs.
   */
  create(input: CreateAgentRunInput): Promise<ConversationAgentRunRecord>
  /**
   * Persist or replay one idempotent child run while atomically enforcing parent fan-out. In one
   * transaction it creates the child's thread or takes it (single-flight, as a conversation), then
   * appends the trigger and the run.
   */
  createSubagent(input: CreateSubagentRunInput): Promise<SubagentRunRecord>
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
  /**
   * Record that a running run was asked to stop, keeping the first time it was. A run in any other
   * state is returned as it is: a queued one is cancelled with `finishQueued`.
   */
  requestCancel(input: RequestAgentRunCancelInput): Promise<AgentRunRecord>
  /**
   * Finalize a run and release the thread's `activeRunId`. `finishReason: "awaiting_approval"`
   * needs a call the run holds (see `approvals.holdsRun`). A turn that ends any other way cancels
   * its pending approvals and stops resuming on the rest; a child that fails or is cancelled
   * cancels its own pending ones.
   */
  finish(input: FinishAgentRunInput): Promise<AgentRunRecord>
  getById(params: { projectId: string; id: string }): Promise<AgentRunRecord | null>
  getByIds(params: {
    projectId: string
    ids: readonly string[]
  }): Promise<readonly AgentRunRecord[]>
  /**
   * The children of a conversation's turns, the latest turn's first, by its effective start, and
   * within a turn the latest admitted first. Read by key (one per turn) or by finish reason.
   */
  listThreadSubagents(input: ListThreadSubagentsInput): Promise<readonly SubagentRunRecord[]>
  /** The newest run of each thread, by creation and id; a thread without one is absent. */
  latestByThread(input: ListLatestAgentRunsInput): Promise<readonly AgentRunRecord[]>
  list(input: ListAgentRunsInput): Promise<ListAgentRunsResult>
}

export interface AgentMessageStore {
  /** Insert a message (its `parts` are the canonical content) and bump thread stats. */
  append(input: AppendAgentMessageInput): Promise<AgentMessageRecord>
  /**
   * Delete every message produced by one run and repair the thread's message stats. A reader's
   * place past the newest message left comes back to it: the next message reuses those numbers.
   */
  deleteByRunId(input: DeleteAgentMessagesByRunInput): Promise<number>
  /**
   * Delete every message at or after `fromSeq` and repair the thread's message stats. A reader's
   * place past the newest message left comes back to it: the edit that follows reuses the numbers.
   */
  deleteFromSeq(input: DeleteAgentMessagesFromSeqInput): Promise<number>
  getById(params: { projectId: string; id: string }): Promise<AgentMessageRecord | null>
  list(input: ListAgentMessagesInput): Promise<ListAgentMessagesResult>
  /**
   * The threads holding a user message that carries the artifact as context, each once, ordered by
   * id. A message deleted, by a retry or an edit, no longer counts. With a reader, only theirs or
   * those they take part in, found from their side: the cost is theirs, not the project's.
   */
  listThreadIdsByArtifactContext(input: ListAgentThreadIdsByArtifactContextInput): Promise<string[]>
}

export interface DeleteAgentContextCheckpointsAfterSeqInput {
  readonly projectId: string
  readonly threadId: string
  /** Delete checkpoints whose observed head exceeds this retained sequence boundary. */
  readonly afterSeq: number
}

export interface AgentContextCheckpointStore {
  /**
   * Append one checkpoint after atomically validating run ownership and both transcript anchors.
   * Repeating the same payload for the same creating run is idempotent.
   */
  create(input: CreateAgentContextCheckpointInput): Promise<AgentContextCheckpointRecord>
  /** The thread's checkpoints created by the requested runs, in first-occurrence input order. */
  getByRunIds(input: {
    readonly projectId: string
    readonly threadId: string
    readonly runIds: readonly string[]
  }): Promise<readonly AgentContextCheckpointRecord[]>
  getLatest(input: {
    readonly projectId: string
    readonly threadId: string
  }): Promise<AgentContextCheckpointRecord | null>
  /** Delete checkpoints that observed messages past `afterSeq`, newest first. */
  deleteAfterSeq(input: DeleteAgentContextCheckpointsAfterSeqInput): Promise<number>
}

// ── agent_approvals — calls of the Agent that wait for whoever asked ───────────────────────────

/**
 * What the Agent may change without asking its requester: `manual` asks for every action and
 * workflow, `accept-edits` runs the actions that only change Sixb, `auto` runs everything.
 */
export const AGENT_APPROVAL_MODES = ["manual", "accept-edits", "auto"] as const

export type AgentApprovalMode = (typeof AGENT_APPROVAL_MODES)[number]

/** The modes that hold some calls: the one that held a call is recorded on its approval. */
export const AGENT_HOLDING_APPROVAL_MODES = [
  "manual",
  "accept-edits",
] as const satisfies readonly AgentApprovalMode[]

export type AgentHoldingApprovalMode = (typeof AGENT_HOLDING_APPROVAL_MODES)[number]

export const AGENT_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "cancelled",
  "superseded",
  "expired",
] as const

export type AgentApprovalStatus = (typeof AGENT_APPROVAL_STATUSES)[number]

/** The statuses a pending approval is settled to without a decision. */
export type AgentApprovalSettledStatus = Extract<
  AgentApprovalStatus,
  "cancelled" | "superseded" | "expired"
>

/**
 * The held call, as it runs once approved. An action's params are normalized: what the user
 * approves is exactly what runs. Its run id is the one the Agent named, so a repeated request finds
 * the same approval and the same run.
 */
export type AgentApprovalCall =
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly subject: ActionSubject
      readonly params: ActionRunParams
      readonly actionRunId: string
      /** `external` when the action has a writeback or effects: it reaches beyond Sixb. */
      readonly effect: "ontology" | "external"
    }
  | {
      readonly kind: "workflow"
      readonly workflowId: string
      readonly input: JsonObject
      readonly workflowRunId: string
    }

/** What running an approved call gave. */
export type AgentApprovalOutcome =
  | {
      readonly kind: "action-run"
      readonly runId: string
      readonly status: "succeeded" | "failed"
      readonly error?: ActionRunFailure
    }
  | { readonly kind: "workflow-run"; readonly runId: string; readonly queuedAt: string }
  /** The call was refused when it ran, for example because its requester lost a grant. */
  | { readonly kind: "error"; readonly error: SixbFailure }

export interface AgentApprovalRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /** The conversation turn the call belongs to. */
  readonly runId: string
  /** The run that made the call: the turn itself, or one of its children. */
  readonly callerRunId: string
  /** Who asked for the turn: the only one who decides, as the call runs with their rights. */
  readonly requestedBy: Principal
  /** The mode that held the call. */
  readonly mode: AgentHoldingApprovalMode
  /** The call's run id, unique among a thread's pending, approved and denied approvals. */
  readonly callKey: string
  readonly call: AgentApprovalCall
  readonly status: AgentApprovalStatus
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly decidedAt?: Date
  readonly decidedBy?: Principal
  /** Set once an approved call ran. */
  readonly outcome?: AgentApprovalOutcome
  /** The user message that told the model how the approval ended. */
  readonly reportedInMessageId?: string
  /** "Always allow": the mode its requester raised the turn's calls to when deciding this one. */
  readonly raisedMode?: AgentApprovalMode
  /**
   * The turn will not resume for it: stopped, its requester left, or another of its calls was set
   * aside. The thread's next message still reports it.
   */
  readonly turnStoppedAt?: Date
  /** When a process last took the approved call to run it; a stale claim can be taken again. */
  readonly executionClaimedAt?: Date
}

export interface RequestAgentApprovalInput {
  readonly id: string
  readonly projectId: string
  readonly runId: string
  readonly callerRunId: string
  /** The caller run's current delivery token: a stale delivery holds nothing. */
  readonly executionToken: string
  readonly requestedBy: Principal
  readonly mode: AgentHoldingApprovalMode
  readonly call: AgentApprovalCall
  readonly createdAt?: Date
  readonly expiresAt: Date
}

export interface RequestAgentApprovalResult {
  readonly approval: AgentApprovalRecord
  /** `false` when a pending, approved or denied approval of the thread had the same call key. */
  readonly created: boolean
}

export interface DecideAgentApprovalInput {
  readonly projectId: string
  readonly id: string
  readonly decision: "approved" | "denied"
  readonly decidedBy: Principal
  readonly decidedAt?: Date
  /** With `approved`: "Always allow" raised the turn's mode to this one. */
  readonly raisedMode?: AgentApprovalMode
}

export interface DecideAgentApprovalResult {
  /** The approval afterwards: `expired` when its time ran out before this decision. */
  readonly approval: AgentApprovalRecord
  /** Whether this call moved it out of `pending` with the decision. */
  readonly decided: boolean
}

export interface SettleAgentApprovalsInput {
  readonly projectId: string
  readonly threadId: string
  readonly status: AgentApprovalSettledStatus
}

/** Stop a thread's turn, or a requester's turns there, from resuming on their calls. */
export interface StopAgentApprovalsInput {
  readonly projectId: string
  readonly threadId: string
  /** Only the calls of this conversation turn. */
  readonly runId?: string
  /** Only the calls this principal asked for. */
  readonly requestedBy?: Principal
  readonly stoppedAt?: Date
}

export interface StopAgentApprovalsResult {
  /** The pending approvals it cancelled. */
  readonly cancelled: readonly AgentApprovalRecord[]
  /** How many unreported approvals it stopped, the cancelled ones included. */
  readonly stopped: number
}

export interface RewindAgentApprovalsInput {
  readonly projectId: string
  readonly threadId: string
  /** Conversation runs removed from the thread: their approvals leave with them. */
  readonly runIds: readonly string[]
  /**
   * Message ids removed by the rewind: an earlier turn's approval reported in one becomes
   * unreported again so the replacement message carries its outcome.
   */
  readonly clearedMessageIds?: readonly string[]
  readonly cancelledAt?: Date
}

export interface RewindAgentApprovalsResult {
  /** Pending approvals of the rewound runs, as `cancelled` records to announce. */
  readonly cancelled: readonly AgentApprovalRecord[]
  /** Total approvals deleted for the rewound runs. */
  readonly deleted: number
}

/** Where a keyset listing resumes: after this approval, in the order approvals are listed. */
export interface AgentApprovalCursor {
  readonly createdAt: Date
  readonly id: string
}

export interface MarkAgentApprovalsReportedInput {
  readonly projectId: string
  readonly threadId: string
  readonly ids: readonly string[]
  readonly messageId: string
  /** A resume: an approval whose turn was stopped is not marked. */
  readonly resuming?: boolean
}

export interface ListAgentApprovalsInput {
  readonly projectId: string
  readonly threadId?: string
  readonly runId?: string
  readonly requestedBy?: Principal
  readonly statuses?: readonly AgentApprovalStatus[]
  /** `false`: only the approvals no message reported yet. */
  readonly reported?: boolean
  readonly limit?: number
  readonly offset?: number
}

export interface ListAgentApprovalsResult {
  /** Oldest first. */
  readonly approvals: readonly AgentApprovalRecord[]
  readonly hasMore: boolean
  readonly total: number
}

/**
 * Held calls and their decisions. `runs.finish` settles a run's approvals in its own transaction:
 * a turn that pauses keeps them for their decision, any other ending cancels its pending ones.
 */
export interface AgentApprovalStore {
  /**
   * Fenced like a checkpoint: the caller run is running with `executionToken`, and is the
   * conversation turn `runId` or one of its children. Returns the thread's pending, approved or
   * denied approval with the same call key when there is one, and creates one otherwise.
   */
  request(input: RequestAgentApprovalInput): Promise<RequestAgentApprovalResult>
  /** Compare-and-swap from `pending`; `null` when no such approval exists. */
  decide(input: DecideAgentApprovalInput): Promise<DecideAgentApprovalResult | null>
  /** Record what an approved call gave, once: an approval with an outcome is returned unchanged. */
  recordOutcome(input: {
    readonly projectId: string
    readonly id: string
    readonly outcome: AgentApprovalOutcome
  }): Promise<AgentApprovalRecord>
  /** Settle the thread's pending approvals, and return the ones it settled. */
  settle(input: SettleAgentApprovalsInput): Promise<readonly AgentApprovalRecord[]>
  /** Expire the project's pending approvals whose time ran out by `now`, and return them. */
  expireDue(input: {
    readonly projectId: string
    readonly now: Date
    readonly limit?: number
  }): Promise<readonly AgentApprovalRecord[]>
  /**
   * Cancel the matching pending approvals and mark every matching one no message reported yet as
   * stopped: their turn never resumes on them.
   */
  stop(input: StopAgentApprovalsInput): Promise<StopAgentApprovalsResult>
  /**
   * Remove approvals belonging to rewound turns and unmark earlier turns' approvals whose
   * reporting message was removed.
   */
  rewind(input: RewindAgentApprovalsInput): Promise<RewindAgentApprovalsResult>
  /** Mark the ones no message reported yet, and return their ids. */
  markReported(input: MarkAgentApprovalsReportedInput): Promise<readonly string[]>
  /**
   * Whether the run holds a call: one of its approvals, or one it made for its turn, pending, or
   * decided and not reported yet. `runs.finish` checks the same before `awaiting_approval`.
   */
  holdsRun(input: { readonly projectId: string; readonly runId: string }): Promise<boolean>
  /**
   * Take an approved call without an outcome to run it, unless another process took it after
   * `staleBefore`; its decision is its first claim. `null` when it is not there to take.
   */
  claimExecution(input: {
    readonly projectId: string
    readonly id: string
    readonly claimedAt: Date
    readonly staleBefore: Date
  }): Promise<AgentApprovalRecord | null>
  /**
   * What a repair pass works on, oldest first: approved calls without an outcome whose claim is
   * older than `claimableBefore`, and decided calls no message reported whose turn is not stopped.
   */
  listRepairable(input: {
    readonly projectId: string
    readonly claimableBefore: Date
    readonly after?: AgentApprovalCursor
    readonly limit: number
  }): Promise<readonly AgentApprovalRecord[]>
  getById(params: {
    readonly projectId: string
    readonly id: string
  }): Promise<AgentApprovalRecord | null>
  list(input: ListAgentApprovalsInput): Promise<ListAgentApprovalsResult>
}

/** Each user's approval mode: a default, and their own choice in each thread. */
export interface AgentApprovalModeStore {
  getDefault(input: {
    readonly projectId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null>
  setDefault(input: {
    readonly projectId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode
    readonly updatedAt?: Date
  }): Promise<void>
  getForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
  }): Promise<AgentApprovalMode | null>
  /**
   * `null` clears the choice: the user's turns in the thread follow their default again. Throws
   * `thread_not_found` when the thread does not exist.
   */
  setForThread(input: {
    readonly projectId: string
    readonly threadId: string
    readonly principal: Principal
    readonly mode: AgentApprovalMode | null
    readonly updatedAt?: Date
  }): Promise<void>
}

// ── Memory ──────────────────────────────────────────────────────────────────────────────────────

/** One file of a memory repo, at its path from the repo root. */
export interface AgentMemoryFile {
  readonly path: string
  readonly contents: string
}

/** A memory repo as of its latest revision. */
export interface AgentMemoryRepoRecord {
  /** 0 before the first save. */
  readonly revision: number
  /** Ordered by path. */
  readonly files: readonly AgentMemoryFile[]
}

/** One change of a save: the file's new contents, or `null` to delete it. */
export interface AgentMemoryChange {
  readonly path: string
  readonly contents: string | null
}

export interface SaveAgentMemoryInput {
  readonly projectId: string
  /** `user:<userId>` or `project`. */
  readonly repoId: string
  /** The revision the caller loaded. */
  readonly baseRevision: number
  readonly message: string
  readonly author: Principal
  /** The conversation the save came from, `/agents/<threadId>`. */
  readonly source?: string
  readonly changes: readonly AgentMemoryChange[]
  readonly createdAt?: Date
}

export type SaveAgentMemoryResult =
  | { readonly saved: true; readonly revision: number }
  | {
      readonly saved: false
      /** The repo's latest revision. */
      readonly revision: number
      /** Files in `changes` that another save changed after `baseRevision`, as they are now. */
      readonly conflicts: readonly AgentMemoryChange[]
    }

/** One save: who made it, why, and which paths it wrote. A revision never changes. */
export interface AgentMemoryRevisionRecord {
  readonly revision: number
  readonly message: string
  readonly author: Principal
  readonly source?: string
  /** Ordered by path. */
  readonly changes: readonly { readonly path: string; readonly deleted: boolean }[]
  readonly createdAt: Date
}

export interface ListAgentMemoryRevisionsInput {
  readonly projectId: string
  readonly repoId: string
  readonly limit?: number
  readonly offset?: number
}

export interface ListAgentMemoryRevisionsResult {
  /** Newest first. */
  readonly revisions: readonly AgentMemoryRevisionRecord[]
  readonly hasMore: boolean
  readonly total: number
}

/**
 * Memory repos as append-only revisions: a save inserts one revision and the files it wrote, and
 * never updates a row. Paths, sizes and who may save are decided in Core before a call reaches
 * storage.
 */
export interface AgentMemoryStore {
  /**
   * The repo at its latest revision, or with `asOf` at the latest revision saved by then, and with
   * `revision` at the latest up to that one: revision 0 and no files when none was. File versions
   * pruned from the history are missing from it.
   */
  get(input: {
    readonly projectId: string
    readonly repoId: string
    readonly asOf?: Date
    readonly revision?: number
  }): Promise<AgentMemoryRepoRecord>
  /**
   * In one transaction: reports a conflict when a path in `changes` was written after
   * `baseRevision`, or when the repo is behind `baseRevision` because it was deleted; otherwise
   * stores the next revision. The same transaction removes file versions older than
   * {@link AGENT_MEMORY_HISTORY_DAYS} days that are not their path's latest.
   */
  save(input: SaveAgentMemoryInput): Promise<SaveAgentMemoryResult>
  listRevisions(input: ListAgentMemoryRevisionsInput): Promise<ListAgentMemoryRevisionsResult>
  /** Deletes the repo with its history. */
  delete(input: { readonly projectId: string; readonly repoId: string }): Promise<void>
}

/** How long a file version that is not its path's latest stays in a repo's history. */
export const AGENT_MEMORY_HISTORY_DAYS = 90

/** Each open `sixb` on its owner's computers, as a lease it renews. */
export interface AgentComputerSessionStore {
  /**
   * Open the session, or renew it until `expiresAt`; its computer, folder and background commands
   * are kept as given, and its stop requests as they are.
   */
  hold(input: Omit<AgentComputerSessionRecord, "stopRequests">): Promise<void>
  /**
   * Record that someone asked to stop one of its commands, once, keeping the newest
   * {@link AGENT_COMPUTER_BACKGROUND_COMMANDS_MAX}. Null when the owner holds no such session.
   */
  requestStop(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
    readonly command: AgentBackgroundCommandRef
  }): Promise<AgentComputerSessionRecord | null>
  /** End the owner's session; null when it is not open. */
  release(input: {
    readonly projectId: string
    readonly id: string
    readonly ownerPrincipal: Principal
  }): Promise<AgentComputerSessionRecord | null>
  /** The owner's sessions live at `now`. */
  listLive(input: {
    readonly projectId: string
    readonly ownerPrincipal: Principal
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]>
  /** Remove every session that lapsed before `now`, and return them. */
  removeLapsed(input: {
    readonly projectId: string
    readonly now: Date
  }): Promise<readonly AgentComputerSessionRecord[]>
}

// ── agent_token_rates — what each model's tokenizer measured on the project's agent runs ──────

/** How many measurements a project keeps per model: its newest. */
export const AGENT_TOKEN_RATE_SAMPLES = 20

/**
 * The band of bytes per token a measurement may show. Every tokenizer measured on agent turns
 * reads 2.1 to 4.7; a value outside is a broken measurement, and a single one would set its
 * model's rate for the whole project.
 */
export const AGENT_TOKEN_RATE_MIN_BYTES_PER_TOKEN = 1
export const AGENT_TOKEN_RATE_MAX_BYTES_PER_TOKEN = 8

/**
 * One run's measurement of its model's tokenizer: the UTF-8 bytes of a request's text, as the
 * Agent's context estimator weighs them, against the text tokens the provider counted for it.
 */
export interface AgentTokenRateRecord {
  readonly projectId: string
  readonly providerId: string
  readonly modelId: string
  /** The agent run or workflow step that measured it: one measurement each. */
  readonly runId: string
  readonly bytes: number
  readonly tokens: number
  readonly measuredAt: Date
}

/**
 * The newest measurements of each model's bytes per token, per project. Agent runs start their
 * context estimate from them; losing them only makes the next estimates more conservative.
 */
export interface AgentTokenRateStore {
  /**
   * Keep a run's measurement, in place of one it recorded before, and drop the model's
   * measurements past its newest {@link AGENT_TOKEN_RATE_SAMPLES}.
   */
  record(input: AgentTokenRateRecord): Promise<void>
  /** The model's measurements, newest first: at most {@link AGENT_TOKEN_RATE_SAMPLES}. */
  listLatest(input: {
    readonly projectId: string
    readonly providerId: string
    readonly modelId: string
  }): Promise<readonly AgentTokenRateRecord[]>
}

// -- agent_thread_inbox: mid-run steers and queued follow-up messages -------------------------

export const AGENT_INBOX_MODES = ["steer", "queue"] as const
export type AgentInboxMode = (typeof AGENT_INBOX_MODES)[number]

/** Maximum pending items one conversation thread holds in its inbox at once. */
export const AGENT_THREAD_INBOX_MAX_ITEMS = 50

/** Optional per-turn overrides carried by a queued or immediate inbox item. */
export interface AgentInboxSpec {
  readonly model?: LanguageModelRef
  readonly reasoning?: AgentReasoning
  readonly approvalMode?: AgentApprovalMode
}

/** Claim recorded when a running conversation turn drains a `steer` item at a step boundary. */
export interface AgentInboxClaim {
  readonly runId: string
  readonly executionToken: string
  readonly stepIndex: number
  readonly afterAnswer?: boolean
}

export interface AgentInboxItemRecord {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  /** Stable id reserved for `agent_messages` once this item is delivered. */
  readonly messageId: string
  readonly seq: number
  readonly authorPrincipal: Principal
  readonly mode: AgentInboxMode
  readonly parts: readonly AgentMessagePart[]
  readonly spec?: AgentInboxSpec
  readonly timeZone?: string
  readonly locale?: string
  /** Marked by Send now so `afterAgentRunFinished` dispatches it across a user cancel. */
  readonly immediate?: boolean
  /**
   * An edit waiting for the turn it stopped to end: the earlier message it replaces. When it
   * starts, the thread first rewinds to that message. Always sent now, as a queued message.
   */
  readonly replacesMessageId?: string
  /**
   * The execution of the request that sent it. A turn that starts it without a request of its
   * sender's runs as a child of this one, with the sender's grants as they are then.
   */
  readonly executionId?: string
  readonly claimedBy?: AgentInboxClaim
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface EnqueueAgentInboxItemInput {
  readonly id: string
  readonly projectId: string
  readonly threadId: string
  readonly messageId: string
  readonly authorPrincipal: Principal
  readonly mode: AgentInboxMode
  readonly parts: readonly AgentMessagePart[]
  readonly spec?: AgentInboxSpec
  readonly timeZone?: string
  readonly locale?: string
  readonly immediate?: boolean
  /**
   * An edit waiting for the turn it stopped to end: the earlier message it replaces. When it
   * starts, the thread first rewinds to that message. Always sent now, as a queued message.
   */
  readonly replacesMessageId?: string
  readonly executionId?: string
  readonly createdAt?: Date
}

export interface EnqueueAgentInboxItemResult {
  readonly item: AgentInboxItemRecord
  readonly created: boolean
}

export interface ListAgentInboxItemsInput {
  readonly projectId: string
  readonly threadId: string
  /** Whether items already claimed by a running step are included; defaults to `true`. */
  readonly includeClaimed?: boolean
}

export interface UpdateAgentInboxItemInput {
  readonly projectId: string
  readonly threadId: string
  readonly id: string
  readonly mode?: AgentInboxMode
  readonly parts?: readonly AgentMessagePart[]
  readonly spec?: AgentInboxSpec | null
  readonly immediate?: boolean
  readonly updatedAt?: Date
}

export interface RemoveAgentInboxItemInput {
  readonly projectId: string
  readonly threadId: string
  readonly id: string
}

export interface TakeAgentInboxSteersInput {
  readonly projectId: string
  readonly threadId: string
  readonly runId: string
  readonly executionToken: string
  readonly stepIndex: number
  readonly afterAnswer?: boolean
  /**
   * The run's requester: a turn runs as them, so it reads only the steers they sent. Another
   * participant's steer waits for a turn of theirs.
   */
  readonly authorPrincipal: Principal
}

export interface ConsumeClaimedAgentInboxInput {
  readonly projectId: string
  readonly threadId: string
  readonly runId: string
  readonly executionToken: string
  /** Message ids persisted into `agent_messages`; other claims of this run are released. */
  readonly messageIds: readonly string[]
}

export interface TakeNextQueuedAgentInboxInput {
  readonly projectId: string
  readonly threadId: string
  /** When `true`, only an item marked `immediate` is popped (used after a user cancel). */
  readonly onlyImmediate?: boolean
  /**
   * Only an item this person sent: a turn runs as its requester, so it starts the messages they
   * sent, and another participant's waits for a turn of theirs.
   */
  readonly authorPrincipal?: Principal
}

export interface ListWaitingAgentInboxThreadsInput {
  readonly projectId: string
  /** Only threads holding an item created before this: newer ones a turn's end is still starting. */
  readonly createdBefore: Date
  /** Page after this thread id, in id order. */
  readonly afterThreadId?: string
  readonly limit: number
}

export interface AgentInboxStore {
  enqueue(input: EnqueueAgentInboxItemInput): Promise<EnqueueAgentInboxItemResult>
  getById(params: { projectId: string; id: string }): Promise<AgentInboxItemRecord | null>
  list(input: ListAgentInboxItemsInput): Promise<readonly AgentInboxItemRecord[]>
  /** Update an unclaimed inbox item; throws `invalid_state` when already claimed. */
  update(input: UpdateAgentInboxItemInput): Promise<AgentInboxItemRecord | null>
  /** Remove an unclaimed inbox item; throws `invalid_state` when already claimed. */
  remove(input: RemoveAgentInboxItemInput): Promise<AgentInboxItemRecord | null>
  /**
   * Fenced by `(runId, executionToken)`: claim the non-immediate steers `authorPrincipal` sent, in
   * FIFO order. The thread's running turn holds it, so a claim any other execution left behind (one
   * this run replaced, or a turn whose release failed) was never written, and is taken over.
   */
  takeSteers(input: TakeAgentInboxSteersInput): Promise<readonly AgentInboxItemRecord[]>
  /** Consume persisted claims of `(runId, executionToken)` and release any unwritten ones. */
  consumeClaimed(input: ConsumeClaimedAgentInboxInput): Promise<readonly AgentInboxItemRecord[]>
  /** Release remaining claims held by `runId` after an interrupted, failed, or cancelled turn. */
  releaseClaimed(input: { projectId: string; runId: string }): Promise<number>
  /** Pop the next unclaimed item when `thread.activeRunId` is null; null when busy or empty. */
  takeNextQueued(input: TakeNextQueuedAgentInboxInput): Promise<AgentInboxItemRecord | null>
  /** Ids of threads no turn holds whose inbox still holds an item, for the repair pass. */
  listWaitingThreads(input: ListWaitingAgentInboxThreadsInput): Promise<readonly string[]>
}

// ── agent_turn_vectors — each conversation turn's embedding, to find it by meaning ──────────────

/**
 * One turn of a conversation as search finds it: what the person asked, the Agent's final answer
 * and the titles of what the turn published, embedded. A turn too long for one input is split into
 * chunks, each starting with the request, numbered from 0.
 *
 * Keyed by the message that opens the turn, never by its `seq`: a retry or an edit reuses numbers.
 * Deleting that message deletes the turn's vectors with it.
 */
export interface AgentTurnVectorRecord {
  readonly projectId: string
  readonly threadId: string
  /** The person's message that opens the turn. */
  readonly messageId: string
  readonly chunk: number
  /** The `seq` of the turn's first and last messages. */
  readonly firstSeq: number
  readonly lastSeq: number
  /** When the turn's opening message was written. */
  readonly turnAt: Date
  /** What was embedded. */
  readonly text: string
  /** The fingerprint of the model and text format that produced it: another one is stale. */
  readonly configuration: string
  /** Unit length, float32. */
  readonly embedding: readonly number[]
  readonly indexedAt: Date
}

export type AgentTurnVectorInput = Omit<
  AgentTurnVectorRecord,
  "projectId" | "threadId" | "configuration" | "indexedAt"
>

/** Where a conversation's index stands for one configuration, and where indexing resumes. */
export interface AgentThreadIndexProgress {
  readonly threadId: string
  /**
   * Changes whenever a message is added to the thread or taken from it: a write made from what
   * was read at another revision is dropped.
   */
  readonly revision: number
  /** Indexed for this configuration at exactly this revision: nothing to do. */
  readonly current: boolean
  /**
   * The `seq` indexing reads from: the first message of the newest turn indexed, which may have
   * grown since, or of the turn a deletion changed, whichever comes first. 1 for a thread with no
   * vector of this configuration.
   */
  readonly fromSeq: number
  /** Failed tries since it was last written: each waits longer before the next. */
  readonly failures: number
  /** Until when it waits: an AI limit's reset, or a failure's backoff. */
  readonly deferredUntil?: Date
  /**
   * Indexing failed in a way no retry fixes, at this revision and for this configuration: nothing
   * asks for it again until a message is added or taken, or the configuration changes.
   */
  readonly halted: boolean
}

export interface GetAgentThreadIndexProgressInput {
  readonly projectId: string
  readonly threadId: string
  readonly configuration: string
}

export interface WriteAgentTurnVectorsInput {
  readonly projectId: string
  readonly threadId: string
  readonly configuration: string
  /** The revision the turns were read at: nothing is written once the thread changed since. */
  readonly revision: number
  /**
   * The vectors of every turn opening at or after this `seq` are replaced by `turns`, and every
   * vector of another configuration goes.
   */
  readonly fromSeq: number
  readonly turns: readonly AgentTurnVectorInput[]
  /** These turns reach the thread's end: it is then indexed at `revision`. */
  readonly complete: boolean
  readonly indexedAt?: Date
}

export interface ListAgentTurnVectorsInput {
  readonly projectId: string
  readonly threadId: string
  /** Only the turns opening at or after this `seq`. */
  readonly fromSeq?: number
}

export interface ListAgentThreadsToIndexInput {
  readonly projectId: string
  readonly configuration: string
  readonly limit: number
  /** A thread deferred past this is left out. Now by default. */
  readonly now?: Date
}

export interface DeferAgentThreadIndexingInput {
  readonly projectId: string
  readonly threadId: string
  /** Recorded only for a thread with no index yet: it does not change an existing one's. */
  readonly configuration: string
  readonly until: Date
  /** A failure, which counts toward the next backoff, rather than an AI limit. */
  readonly failed: boolean
}

export interface HaltAgentThreadIndexingInput {
  readonly projectId: string
  readonly threadId: string
  /** The configuration it failed for, which the thread's index state is then about. */
  readonly configuration: string
  /** The revision the failing turns were read at: nothing is recorded once the thread moved. */
  readonly revision: number
}

/** A conversation whose index is behind, and the revision it is at now. */
export interface AgentThreadToIndex {
  readonly threadId: string
  readonly revision: number
}

export interface AgentTurnVectorStore {
  /**
   * Whether this storage can search the vectors it keeps: PostgreSQL with pgvector in schema
   * `public`, SQLite with sqlite-vec loadable. A yes is remembered; a no is asked again later.
   */
  searchAvailable(): Promise<boolean>
  /** Null when the thread does not exist. */
  progress(input: GetAgentThreadIndexProgressInput): Promise<AgentThreadIndexProgress | null>
  /**
   * Replace the thread's turns from `fromSeq` on, in one transaction, if its revision is still
   * `revision`. Answers whether it wrote. A write ends any deferral and resets the failures.
   */
  write(input: WriteAgentTurnVectorsInput): Promise<boolean>
  /** Indexing waits until then: the thread leaves `listThreadsToIndex` meanwhile. */
  defer(input: DeferAgentThreadIndexingInput): Promise<void>
  /**
   * Indexing stops at `revision` for this configuration, if the thread is still at it: answers
   * whether it recorded. The thread is behind, but leaves `listThreadsToIndex` until it changes or
   * the configuration does. A write lifts it.
   */
  halt(input: HaltAgentThreadIndexingInput): Promise<boolean>
  /** By `firstSeq`, then chunk. */
  list(input: ListAgentTurnVectorsInput): Promise<readonly AgentTurnVectorRecord[]>
  /**
   * Conversations no turn holds, nothing defers and nothing halted whose index is behind for this
   * configuration, the most recently active first. A sub-agent's thread is never indexed.
   */
  listThreadsToIndex(input: ListAgentThreadsToIndexInput): Promise<readonly AgentThreadToIndex[]>
}

export interface AgentStorage {
  readonly threads: AgentThreadStore
  readonly reads: AgentThreadReadStore
  readonly runs: AgentRunStore
  readonly messages: AgentMessageStore
  readonly checkpoints: AgentContextCheckpointStore
  readonly memory: AgentMemoryStore
  readonly approvals: AgentApprovalStore
  readonly approvalModes: AgentApprovalModeStore
  readonly computers: AgentComputerSessionStore
  readonly tokenRates: AgentTokenRateStore
  readonly inbox: AgentInboxStore
  readonly turnVectors: AgentTurnVectorStore
}
