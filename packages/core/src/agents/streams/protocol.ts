import type { Broker, BrokerStreamDefinition } from "../../broker"
import { parseSixbFailure } from "../../errors/internal"
import type { SixbFailure } from "../../errors/types"
import { isPlainRecord, type JsonValue } from "../../json"
import { isModelUiChunk, type ModelUiChunk } from "../../models/events"
import {
  AGENT_APPROVAL_STATUSES,
  AGENT_RUN_FAILURE_CODES,
  type AgentApprovalRecord,
  type AgentApprovalStatus,
  type AgentContextCheckpointReason,
  type AgentRunFailureCode,
  type AgentRunRecord,
  type ConversationAgentRunRecord,
} from "../../storage/agents/types"

export const AGENT_RUN_STREAM_SCHEMA_VERSION = 1 as const
export const DEFAULT_AGENT_RUN_STREAM_RETENTION = {
  maxAgeMs: 2 * 60 * 60 * 1000, // 2 hours
  maxRecords: 5_000,
} as const

export const AGENT_ACTIVITY_STREAM_SCHEMA_VERSION = 1 as const
export const AGENT_ACTIVITY_STREAM_ID = "agents.activity" as const
export const DEFAULT_AGENT_ACTIVITY_STREAM_RETENTION = {
  maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
  maxRecords: 10_000,
} as const

export interface AgentRunActivityEvent {
  readonly schemaVersion: typeof AGENT_ACTIVITY_STREAM_SCHEMA_VERSION
  readonly type: "agent.run.activity"
  readonly projectId: string
  readonly runId: string
  readonly threadId: string
  readonly status: AgentRunRecord["status"]
  readonly attempt: number
  /** Set on a computer's turn: a `sixb` hearing of any other has nothing to read about it. */
  readonly runsOn?: "computer"
  readonly occurredAt: string
}

export function agentActivityStreamDefinition(): BrokerStreamDefinition {
  return {
    id: AGENT_ACTIVITY_STREAM_ID,
    retention: DEFAULT_AGENT_ACTIVITY_STREAM_RETENTION,
  }
}

export function agentRunActivityEvent(
  run: ConversationAgentRunRecord,
  occurredAt: Date = new Date()
): AgentRunActivityEvent {
  return {
    schemaVersion: AGENT_ACTIVITY_STREAM_SCHEMA_VERSION,
    type: "agent.run.activity",
    projectId: run.projectId,
    runId: run.id,
    threadId: run.threadId,
    status: run.status,
    attempt: run.attempt,
    ...(run.spec?.runsOn === "computer" ? { runsOn: "computer" as const } : {}),
    occurredAt: occurredAt.toISOString(),
  }
}

export function isAgentRunActivityEvent(value: unknown): value is AgentRunActivityEvent {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === AGENT_ACTIVITY_STREAM_SCHEMA_VERSION &&
    value.type === "agent.run.activity" &&
    typeof value.projectId === "string" &&
    typeof value.runId === "string" &&
    typeof value.threadId === "string" &&
    isAgentRunStatus(value.status) &&
    typeof value.attempt === "number" &&
    Number.isFinite(value.attempt) &&
    (value.runsOn === undefined || value.runsOn === "computer") &&
    typeof value.occurredAt === "string"
  )
}

/**
 * A held call of a thread's turn changed: it was held, decided, ran, or was set aside. Clients read
 * the thread's approvals again.
 */
export interface AgentApprovalActivityEvent {
  readonly schemaVersion: typeof AGENT_ACTIVITY_STREAM_SCHEMA_VERSION
  readonly type: "agent.approval.activity"
  readonly projectId: string
  readonly approvalId: string
  readonly threadId: string
  /** The conversation turn the call belongs to. */
  readonly runId: string
  readonly status: AgentApprovalStatus
  /** Whether the approved call ran and has its outcome. */
  readonly hasOutcome: boolean
  readonly occurredAt: string
}

/**
 * An open `sixb` on its owner's computer came or went: the threads that run on that computer in
 * that folder are reachable now, or not. Only its owner hears it.
 */
export interface AgentComputerActivityEvent {
  readonly schemaVersion: typeof AGENT_ACTIVITY_STREAM_SCHEMA_VERSION
  readonly type: "agent.computer.activity"
  readonly projectId: string
  readonly ownerPrincipal: { readonly type: string; readonly id: string }
  readonly computerId: string
  readonly folder: string
  readonly online: boolean
  readonly occurredAt: string
}

/** A thread moved to another folder or computer, or to the cloud. Its owner alone hears it. */
export interface AgentThreadMovedEvent {
  readonly schemaVersion: typeof AGENT_ACTIVITY_STREAM_SCHEMA_VERSION
  readonly type: "agent.thread.moved"
  readonly projectId: string
  readonly ownerPrincipal: { readonly type: string; readonly id: string }
  readonly threadId: string
  readonly occurredAt: string
}

/** Everything the project's activity feed carries. */
export type AgentActivityEvent =
  | AgentRunActivityEvent
  | AgentApprovalActivityEvent
  | AgentComputerActivityEvent
  | AgentThreadMovedEvent

export function agentApprovalActivityEvent(
  approval: AgentApprovalRecord,
  occurredAt: Date = new Date()
): AgentApprovalActivityEvent {
  return {
    schemaVersion: AGENT_ACTIVITY_STREAM_SCHEMA_VERSION,
    type: "agent.approval.activity",
    projectId: approval.projectId,
    approvalId: approval.id,
    threadId: approval.threadId,
    runId: approval.runId,
    status: approval.status,
    hasOutcome: approval.outcome !== undefined,
    occurredAt: occurredAt.toISOString(),
  }
}

export function isAgentApprovalActivityEvent(value: unknown): value is AgentApprovalActivityEvent {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === AGENT_ACTIVITY_STREAM_SCHEMA_VERSION &&
    value.type === "agent.approval.activity" &&
    typeof value.projectId === "string" &&
    typeof value.approvalId === "string" &&
    typeof value.threadId === "string" &&
    typeof value.runId === "string" &&
    (AGENT_APPROVAL_STATUSES as readonly unknown[]).includes(value.status) &&
    typeof value.hasOutcome === "boolean" &&
    typeof value.occurredAt === "string"
  )
}

function isAgentComputerActivityEvent(value: unknown): value is AgentComputerActivityEvent {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === AGENT_ACTIVITY_STREAM_SCHEMA_VERSION &&
    value.type === "agent.computer.activity" &&
    typeof value.projectId === "string" &&
    isPlainRecord(value.ownerPrincipal) &&
    typeof value.ownerPrincipal.type === "string" &&
    typeof value.ownerPrincipal.id === "string" &&
    typeof value.computerId === "string" &&
    typeof value.folder === "string" &&
    typeof value.online === "boolean" &&
    typeof value.occurredAt === "string"
  )
}

function isAgentThreadMovedEvent(value: unknown): value is AgentThreadMovedEvent {
  return (
    isPlainRecord(value) &&
    value.schemaVersion === AGENT_ACTIVITY_STREAM_SCHEMA_VERSION &&
    value.type === "agent.thread.moved" &&
    typeof value.projectId === "string" &&
    isPlainRecord(value.ownerPrincipal) &&
    typeof value.ownerPrincipal.type === "string" &&
    typeof value.ownerPrincipal.id === "string" &&
    typeof value.threadId === "string" &&
    typeof value.occurredAt === "string"
  )
}

export function isAgentActivityEvent(value: unknown): value is AgentActivityEvent {
  return (
    isAgentRunActivityEvent(value) ||
    isAgentApprovalActivityEvent(value) ||
    isAgentComputerActivityEvent(value) ||
    isAgentThreadMovedEvent(value)
  )
}

/** Announce that the owner's computer is reachable, or no longer, in a folder. */
export async function publishAgentComputerActivity(
  broker: Broker,
  input: Omit<AgentComputerActivityEvent, "schemaVersion" | "type" | "occurredAt">
): Promise<void> {
  const event: AgentComputerActivityEvent = {
    schemaVersion: AGENT_ACTIVITY_STREAM_SCHEMA_VERSION,
    type: "agent.computer.activity",
    ...input,
    occurredAt: new Date().toISOString(),
  }
  await appendActivity(
    broker,
    event,
    event.computerId,
    `${event.computerId}:${event.folder}:${event.online}:${event.occurredAt}`
  )
}

/** Announce that a thread moved, so whatever has it open follows. */
export async function publishAgentThreadMoved(
  broker: Broker,
  input: Omit<AgentThreadMovedEvent, "schemaVersion" | "type" | "occurredAt">
): Promise<void> {
  const event: AgentThreadMovedEvent = {
    schemaVersion: AGENT_ACTIVITY_STREAM_SCHEMA_VERSION,
    type: "agent.thread.moved",
    ...input,
    occurredAt: new Date().toISOString(),
  }
  await appendActivity(broker, event, event.threadId, `${event.threadId}:moved:${event.occurredAt}`)
}

async function appendActivity(
  broker: Broker,
  event: AgentComputerActivityEvent | AgentThreadMovedEvent,
  key: string,
  idempotencyKey: string
): Promise<void> {
  await broker.ensureStream({ projectId: event.projectId, stream: agentActivityStreamDefinition() })
  await broker.append({
    projectId: event.projectId,
    streamId: AGENT_ACTIVITY_STREAM_ID,
    records: [
      {
        name: event.type,
        key,
        // The event is composed only of validated JSON primitives.
        payload: event as unknown as JsonValue,
        idempotencyKey,
      },
    ],
  })
}

/** Announce held calls that changed, in one append. Each change is announced once. */
export async function publishAgentApprovalActivity(
  broker: Broker,
  approvals: readonly AgentApprovalRecord[]
): Promise<void> {
  const first = approvals[0]
  if (!first) return

  await broker.ensureStream({
    projectId: first.projectId,
    stream: agentActivityStreamDefinition(),
  })
  await broker.append({
    projectId: first.projectId,
    streamId: AGENT_ACTIVITY_STREAM_ID,
    records: approvals.map((approval) => {
      const event = agentApprovalActivityEvent(approval)
      return {
        name: event.type,
        key: event.threadId,
        // The event is composed only of validated JSON primitives.
        payload: event as unknown as JsonValue,
        idempotencyKey: `${event.approvalId}:${event.status}${event.hasOutcome ? ":outcome" : ""}`,
      }
    }),
  })
}

export async function publishAgentRunActivity(
  broker: Broker,
  run: ConversationAgentRunRecord
): Promise<void> {
  const event = agentRunActivityEvent(run)
  await broker.ensureStream({
    projectId: run.projectId,
    stream: agentActivityStreamDefinition(),
  })
  await broker.append({
    projectId: run.projectId,
    streamId: AGENT_ACTIVITY_STREAM_ID,
    records: [
      {
        name: event.type,
        key: event.threadId,
        // The event is composed only of validated JSON primitives.
        payload: event as unknown as JsonValue,
        idempotencyKey: `${event.runId}:${event.attempt}:${event.status}`,
      },
    ],
  })
}

export type AgentRunStreamId = `agents.runs.${string}`

export function agentRunStreamId(runId: string): AgentRunStreamId {
  return `agents.runs.${runId}`
}

export function agentRunStreamDefinition(runId: string): BrokerStreamDefinition {
  return {
    id: agentRunStreamId(runId),
    retention: DEFAULT_AGENT_RUN_STREAM_RETENTION,
  }
}

type AgentRunStreamEventBase = {
  readonly schemaVersion: typeof AGENT_RUN_STREAM_SCHEMA_VERSION
  readonly projectId: string
  readonly runId: string
  readonly attempt: number
  readonly occurredAt: string
} & (
  | {
      readonly threadId: string
      readonly parentRunId?: never
    }
  | {
      readonly parentRunId: string
      readonly threadId?: never
    }
)

// ── Control stream (worker-inbound) ─────────────────────────────────────────────────────────────
//
// A per-run channel the API layer publishes to and the worker subscribes to — the reverse direction
// of the event stream above. It carries only a cancel signal, and is addressed by `runId` (not a run
// record), so a cancel works even before the worker has reserved the run. Kept separate from the
// event stream so control records never reach the browser client.

export type AgentRunControlStreamId = `agents.runs.${string}.control`

export function agentRunControlStreamId(runId: string): AgentRunControlStreamId {
  return `agents.runs.${runId}.control`
}

/** The only control record: a request to stop the run. */
export const AGENT_RUN_CANCEL_RECORD = "agent.run.cancel"

// A cancel only needs to outlive the queue wait plus one turn, so retention is short and tiny.
const AGENT_RUN_CONTROL_RETENTION = { maxAgeMs: 30 * 60 * 1000, maxRecords: 16 } as const

export function agentRunControlStreamDefinition(runId: string): BrokerStreamDefinition {
  return { id: agentRunControlStreamId(runId), retention: AGENT_RUN_CONTROL_RETENTION }
}

/**
 * Signal a run to stop. Publishing is addressed by `runId`, so it works whether the run is queued,
 * reserved, or being drained — the worker picks the record up when it subscribes.
 */
export async function publishAgentRunCancel(
  broker: Broker,
  params: { readonly projectId: string; readonly runId: string }
): Promise<void> {
  await broker.ensureStream({
    projectId: params.projectId,
    stream: agentRunControlStreamDefinition(params.runId),
  })
  await broker.append({
    projectId: params.projectId,
    streamId: agentRunControlStreamId(params.runId),
    records: [
      {
        name: AGENT_RUN_CANCEL_RECORD,
        key: params.runId,
        payload: { runId: params.runId },
        idempotencyKey: `${params.runId}:cancel`,
      },
    ],
  })
}

/**
 * Watch a run's control stream and invoke `onCancel` when a cancel arrives. Reads from `earliest` so
 * a cancel published before the worker subscribed (a run stopped while still queued) is still seen.
 * Returns the unsubscribe handle.
 */
export async function subscribeAgentRunCancel(
  broker: Broker,
  params: { readonly projectId: string; readonly runId: string },
  onCancel: () => void
): Promise<() => void> {
  await broker.ensureStream({
    projectId: params.projectId,
    stream: agentRunControlStreamDefinition(params.runId),
  })
  return broker.subscribe(
    {
      projectId: params.projectId,
      streamId: agentRunControlStreamId(params.runId),
      from: "earliest",
      names: [AGENT_RUN_CANCEL_RECORD],
    },
    () => onCancel()
  )
}

/** Exact portable failure exposed by a terminal Agent run stream event. */
export type AgentRunFailure = SixbFailure<AgentRunFailureCode>

export const AGENT_COMPACTION_FAILURE_CODES = [
  "context_limit_exceeded",
  "summary_failed",
  "checkpoint_failed",
] as const
export type AgentCompactionFailureCode = (typeof AGENT_COMPACTION_FAILURE_CODES)[number]

export type AgentRunStreamEvent =
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.started"
      readonly modelId?: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.compaction.started"
      readonly reason: AgentContextCheckpointReason
      readonly estimatedInputTokensBefore: number
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.compaction.completed"
      readonly reason: AgentContextCheckpointReason
      readonly checkpointId: string
      readonly estimatedInputTokensBefore: number
      readonly estimatedInputTokensAfter: number
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.compaction.failed"
      readonly reason: AgentContextCheckpointReason
      readonly errorCode: AgentCompactionFailureCode
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.ui.chunk"
      readonly chunkIndex: number
      readonly chunk: ModelUiChunk
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.message.finalized"
      readonly messageId: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.finished"
      readonly status: "succeeded" | "failed" | "cancelled"
      readonly finishReason?: string
      readonly error?: AgentRunFailure
    })

export type AgentRunFinishedEvent = Extract<AgentRunStreamEvent, { type: "agent.run.finished" }>

// ── Record construction ──────────────────────────────────────────────────────────────────────────
//
// The wire format of run stream records — event shape, record name/key, and the idempotency-key
// vocabulary — is owned here so every producer (the worker's stream sink, the server's queued
// cancellation) shares one definition and cannot drift.

/** Build the terminal stream event for a finished run. Throws if the run is not terminal. */
export function agentRunFinishedEvent(
  run: AgentRunRecord,
  occurredAt: Date = new Date()
): AgentRunFinishedEvent {
  if (run.status === "queued" || run.status === "running") {
    throw new Error(
      `[Sixb] Agent run '${run.id}' is not terminal (status '${run.status}'), so it has no finished event.`
    )
  }
  return {
    ...agentRunStreamEventBase(run, occurredAt),
    type: "agent.run.finished",
    status: run.status,
    ...(run.finishReason === undefined ? {} : { finishReason: run.finishReason }),
    ...(run.error === undefined ? {} : { error: run.error }),
  }
}

/** Shared lineage for stream records emitted by conversational and headless runs. */
export function agentRunStreamEventBase(
  run: AgentRunRecord,
  occurredAt: Date = new Date()
): AgentRunStreamEventBase {
  const common = {
    schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
    projectId: run.projectId,
    runId: run.id,
    attempt: run.attempt,
    occurredAt: occurredAt.toISOString(),
  }
  return run.kind === "conversation"
    ? { ...common, threadId: run.threadId }
    : { ...common, parentRunId: run.parentRunId }
}

/** Validate an Agent stream payload using the same contract its producers use. */
export function isAgentRunStreamEvent(value: unknown): value is AgentRunStreamEvent {
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== AGENT_RUN_STREAM_SCHEMA_VERSION ||
    typeof value.projectId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.attempt !== "number" ||
    !Number.isFinite(value.attempt) ||
    typeof value.occurredAt !== "string" ||
    typeof value.type !== "string"
  ) {
    return false
  }
  const hasConversationLineage =
    typeof value.threadId === "string" && value.parentRunId === undefined
  const hasSubagentLineage = typeof value.parentRunId === "string" && value.threadId === undefined
  if (!hasConversationLineage && !hasSubagentLineage) return false

  switch (value.type) {
    case "agent.run.started":
      return value.modelId === undefined || typeof value.modelId === "string"
    case "agent.compaction.started":
      return (
        isAgentContextCheckpointReason(value.reason) &&
        isTokenEstimate(value.estimatedInputTokensBefore)
      )
    case "agent.compaction.completed":
      return (
        isAgentContextCheckpointReason(value.reason) &&
        typeof value.checkpointId === "string" &&
        isTokenEstimate(value.estimatedInputTokensBefore) &&
        isTokenEstimate(value.estimatedInputTokensAfter)
      )
    case "agent.compaction.failed":
      return (
        isAgentContextCheckpointReason(value.reason) &&
        AGENT_COMPACTION_FAILURE_CODES.includes(value.errorCode as AgentCompactionFailureCode)
      )
    case "agent.ui.chunk":
      // A chunk type this reader does not know fails here, so a newer producer's chunk is skipped.
      return Number.isInteger(value.chunkIndex) && isModelUiChunk(value.chunk)
    case "agent.message.finalized":
      return typeof value.messageId === "string"
    case "agent.run.finished":
      return (
        isTerminalAgentRunStatus(value.status) &&
        (value.finishReason === undefined || typeof value.finishReason === "string") &&
        (value.error === undefined || isAgentRunFailure(value.error))
      )
    default:
      return false
  }
}

function isAgentContextCheckpointReason(value: unknown): value is AgentContextCheckpointReason {
  return value === "threshold" || value === "overflow"
}

function isTokenEstimate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isTerminalAgentRunStatus(value: unknown): value is "succeeded" | "failed" | "cancelled" {
  return value === "succeeded" || value === "failed" || value === "cancelled"
}

function isAgentRunStatus(value: unknown): value is AgentRunRecord["status"] {
  return value === "queued" || value === "running" || isTerminalAgentRunStatus(value)
}

function isAgentRunFailure(value: unknown): value is AgentRunFailure {
  if (!isPlainRecord(value)) return false
  try {
    parseSixbFailure(value, AGENT_RUN_FAILURE_CODES)
    return true
  } catch {
    return false
  }
}

/** Single owner of the idempotency-key vocabulary for agent run stream records. */
export function agentRunStreamIdempotencyKey(event: AgentRunStreamEvent): string {
  switch (event.type) {
    case "agent.run.started":
      return `${event.runId}:${event.attempt}:started`
    case "agent.compaction.started":
      return `${event.runId}:${event.attempt}:compaction:${event.reason}:started`
    case "agent.compaction.completed":
      return `${event.runId}:${event.attempt}:compaction:${event.checkpointId}:completed`
    case "agent.compaction.failed":
      return `${event.runId}:${event.attempt}:compaction:${event.reason}:failed:${event.errorCode}`
    case "agent.ui.chunk":
      return `${event.runId}:${event.attempt}:chunk:${event.chunkIndex}`
    case "agent.message.finalized":
      return `${event.runId}:${event.attempt}:message:${event.messageId}:finalized`
    case "agent.run.finished":
      return `${event.runId}:${event.attempt}:finished:${event.status}`
  }
}

/**
 * Ensure the run's stream and append its terminal record — mirrors {@link publishAgentRunCancel}.
 * Used where a terminal transition happens outside the worker (e.g. cancelling a queued run).
 */
export async function publishAgentRunFinished(broker: Broker, run: AgentRunRecord): Promise<void> {
  const event = agentRunFinishedEvent(run)
  await broker.ensureStream({
    projectId: run.projectId,
    stream: agentRunStreamDefinition(run.id),
  })
  await broker.append({
    projectId: run.projectId,
    streamId: agentRunStreamId(run.id),
    records: [
      {
        name: event.type,
        key: event.runId,
        // The event is built from JSON primitives only, so the round-trip is a safe narrowing.
        payload: JSON.parse(JSON.stringify(event)) as JsonValue,
        idempotencyKey: agentRunStreamIdempotencyKey(event),
      },
    ],
  })
  if (run.kind === "conversation") await publishAgentRunActivity(broker, run)
}
