import type { Broker, BrokerStreamDefinition } from "../broker"
import type { JsonValue } from "../json"
import type { AgentRunRecord } from "../storage/agents/types"

export const AGENT_RUN_STREAM_SCHEMA_VERSION = 1 as const
export const DEFAULT_AGENT_RUN_STREAM_RETENTION = {
  maxAgeMs: 2 * 60 * 60 * 1000, // 2 hours
  maxRecords: 5_000,
} as const

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

interface AgentRunStreamEventBase {
  readonly schemaVersion: typeof AGENT_RUN_STREAM_SCHEMA_VERSION
  readonly projectId: string
  readonly runId: string
  readonly threadId: string
  readonly agentId: string
  readonly attempt: number
  readonly occurredAt: string
}

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
      { name: AGENT_RUN_CANCEL_RECORD, key: params.runId, payload: { runId: params.runId } },
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

export type AgentRunStreamEvent =
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.started"
      readonly modelId?: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.ui.chunk"
      readonly chunkIndex: number
      readonly chunk: JsonValue
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.message.finalized"
      readonly messageId: string
    })
  | (AgentRunStreamEventBase & {
      readonly type: "agent.run.finished"
      readonly status: "succeeded" | "failed" | "cancelled"
      readonly finishReason?: string
      readonly error?: string
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
    schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
    type: "agent.run.finished",
    projectId: run.projectId,
    runId: run.id,
    threadId: run.threadId,
    agentId: run.agentId,
    attempt: run.attempt,
    status: run.status,
    ...(run.finishReason === undefined ? {} : { finishReason: run.finishReason }),
    ...(run.error === undefined ? {} : { error: run.error }),
    occurredAt: occurredAt.toISOString(),
  }
}

/** Single owner of the idempotency-key vocabulary for agent run stream records. */
export function agentRunStreamIdempotencyKey(event: AgentRunStreamEvent): string {
  switch (event.type) {
    case "agent.run.started":
      return `${event.runId}:${event.attempt}:started`
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
}
