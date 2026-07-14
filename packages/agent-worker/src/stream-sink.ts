import type { AgentRunRecord, AgentRunStreamEvent, Broker, JsonValue } from "@sixb/core"
import {
  AGENT_RUN_STREAM_SCHEMA_VERSION,
  agentRunFinishedEvent,
  agentRunStreamDefinition,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
} from "@sixb/core"
import { AgentWorkerError } from "./errors"

/** Receives live and lifecycle records for one agent run stream. */
export interface StreamSink {
  publishStarted(run: AgentRunRecord): Promise<void>
  publishUiChunk(input: {
    readonly run: AgentRunRecord
    readonly chunkIndex: number
    readonly chunk: unknown
  }): Promise<void>
  publishMessageFinalized(input: {
    readonly run: AgentRunRecord
    readonly messageId: string
  }): Promise<void>
  publishRunFinished(run: AgentRunRecord): Promise<void>
}

/** Test sink that keeps the worker running without publishing live stream records. */
export const NOOP_STREAM_SINK: StreamSink = {
  async publishStarted() {},
  async publishUiChunk() {},
  async publishMessageFinalized() {},
  async publishRunFinished() {},
}

/** Creates the default sink backed by Sixb's broker stream contract. */
export function createBrokerStreamSink(input: {
  readonly broker: Broker
  readonly projectId: string
}): StreamSink {
  return new BrokerStreamSink(input.broker, input.projectId)
}

/** Keeps stream delivery observational so sink failures never fail a turn. */
export function isolateStreamSink(sink: StreamSink): StreamSink {
  return {
    publishStarted: (run) =>
      isolateStreamSinkCall(run.id, "started", () => sink.publishStarted(run)),
    publishUiChunk: (input) =>
      isolateStreamSinkCall(input.run.id, "ui chunk", () => sink.publishUiChunk(input)),
    publishMessageFinalized: (input) =>
      isolateStreamSinkCall(input.run.id, "message finalized", () =>
        sink.publishMessageFinalized(input)
      ),
    publishRunFinished: (run) =>
      isolateStreamSinkCall(run.id, "run finished", () => sink.publishRunFinished(run)),
  }
}

class BrokerStreamSink implements StreamSink {
  private readonly ensured = new Set<string>()

  constructor(
    private readonly broker: Broker,
    private readonly projectId: string
  ) {}

  async publishStarted(run: AgentRunRecord): Promise<void> {
    await this.publish({
      schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
      type: "agent.run.started",
      projectId: this.projectId,
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      attempt: run.attempt,
      ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
      occurredAt: new Date().toISOString(),
    })
  }

  /** Publishes one live UI chunk; awaited per chunk so broker backpressure throttles the token stream. */
  async publishUiChunk(input: {
    readonly run: AgentRunRecord
    readonly chunkIndex: number
    readonly chunk: unknown
  }): Promise<void> {
    let chunk: JsonValue
    try {
      chunk = toBrokerJson(input.chunk, "Agent stream chunk")
    } catch (error) {
      console.error("[SixbAgentWorker] Agent run stream chunk encoding failed:", error)
      return
    }

    // `chunk` is already validated JSON and every other field is a JSON primitive, so the event is
    // JSON as-built. Publish it pre-validated so the chunk — the highest-frequency agent event, one
    // per streamed token batch — is not serialized a second time inside `publish`.
    await this.publish(
      {
        schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
        type: "agent.ui.chunk",
        projectId: this.projectId,
        runId: input.run.id,
        threadId: input.run.threadId,
        agentId: input.run.agentId,
        attempt: input.run.attempt,
        chunkIndex: input.chunkIndex,
        chunk,
        occurredAt: new Date().toISOString(),
      },
      { prevalidated: true }
    )
  }

  async publishMessageFinalized(input: {
    readonly run: AgentRunRecord
    readonly messageId: string
  }): Promise<void> {
    await this.publish({
      schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
      type: "agent.message.finalized",
      projectId: this.projectId,
      runId: input.run.id,
      threadId: input.run.threadId,
      agentId: input.run.agentId,
      attempt: input.run.attempt,
      messageId: input.messageId,
      occurredAt: new Date().toISOString(),
    })
  }

  async publishRunFinished(run: AgentRunRecord): Promise<void> {
    if (run.status === "queued" || run.status === "running") {
      return
    }
    await this.publish(agentRunFinishedEvent(run))
    // This is the last event for the run, so drop its ensured-stream marker to bound the Set over a
    // long-lived worker. Evict only after a successful append, and only on the terminal path.
    this.ensured.delete(agentRunStreamId(run.id))
  }

  private async publish(
    event: AgentRunStreamEvent,
    options: { readonly prevalidated?: boolean } = {}
  ): Promise<void> {
    await this.ensure(event.runId)
    // Broker payloads are plain JSON; keep SDK-specific chunk shapes opaque at this boundary. A
    // pre-validated event (its only opaque field, the chunk, was already encoded by the caller) is
    // already JSON, so it is forwarded as-is instead of being serialized a second time.
    const payload = options.prevalidated
      ? (event as unknown as JsonValue)
      : toBrokerJson(event, "Agent stream event")
    await this.broker.append({
      projectId: this.projectId,
      streamId: agentRunStreamId(event.runId),
      records: [
        {
          name: event.type,
          key: event.runId,
          payload,
          idempotencyKey: agentRunStreamIdempotencyKey(event),
        },
      ],
    })
  }

  private async ensure(runId: string): Promise<void> {
    const streamId = agentRunStreamId(runId)
    if (this.ensured.has(streamId)) {
      return
    }
    await this.broker.ensureStream({
      projectId: this.projectId,
      stream: agentRunStreamDefinition(runId),
    })
    this.ensured.add(streamId)
  }
}

async function isolateStreamSinkCall(
  runId: string,
  label: string,
  publish: () => Promise<void>
): Promise<void> {
  try {
    await publish()
  } catch (error) {
    console.error(`[SixbAgentWorker] Agent run '${runId}' ${label} stream publish failed:`, error)
  }
}

function toBrokerJson(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new AgentWorkerError(`${label} serialized to undefined.`)
    }
    // The stringify/parse round-trip already yields a pure JSON value (functions/symbols/undefined
    // are dropped or throw above, NaN/Infinity become null), so no further validation is needed —
    // the broker append boundary re-checks the payload anyway.
    return JSON.parse(serialized) as JsonValue
  } catch (error) {
    throw new AgentWorkerError(`${label} could not be JSON encoded.`, { cause: error })
  }
}
