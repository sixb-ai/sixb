import type { Broker, JsonValue } from "@sixb/core"
import type { AgentCompactionFailureCode, AgentRunStreamEvent } from "@sixb/core/agents/streams"
import {
  AGENT_RUN_STREAM_SCHEMA_VERSION,
  agentRunFinishedEvent,
  agentRunStreamDefinition,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
  publishAgentRunActivity,
} from "@sixb/core/agents/streams"
import { createSixbError } from "@sixb/core/internal/errors"
import type { AgentContextCheckpointReason, AgentRunRecord } from "@sixb/core/storage"

export interface CompactionStartedInput {
  readonly run: AgentRunRecord
  readonly reason: AgentContextCheckpointReason
  readonly estimatedInputTokensBefore: number
}

export interface CompactionCompletedInput extends CompactionStartedInput {
  readonly checkpointId: string
  readonly estimatedInputTokensAfter: number
}

export interface CompactionFailedInput {
  readonly run: AgentRunRecord
  readonly reason: AgentContextCheckpointReason
  readonly errorCode: AgentCompactionFailureCode
}

/** Receives live and lifecycle records for one agent run stream. */
export interface StreamSink {
  publishStarted(run: AgentRunRecord): Promise<void>
  publishCompactionStarted(input: CompactionStartedInput): Promise<void>
  publishCompactionCompleted(input: CompactionCompletedInput): Promise<void>
  publishCompactionFailed(input: CompactionFailedInput): Promise<void>
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
  async publishCompactionStarted() {},
  async publishCompactionCompleted() {},
  async publishCompactionFailed() {},
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
    publishCompactionStarted: (input) =>
      isolateStreamSinkCall(input.run.id, "compaction started", () =>
        sink.publishCompactionStarted(input)
      ),
    publishCompactionCompleted: (input) =>
      isolateStreamSinkCall(input.run.id, "compaction completed", () =>
        sink.publishCompactionCompleted(input)
      ),
    publishCompactionFailed: (input) =>
      isolateStreamSinkCall(input.run.id, "compaction failed", () =>
        sink.publishCompactionFailed(input)
      ),
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

/** Keep the project lifecycle feed platform-owned even when callers replace transcript streaming. */
export function withAgentActivityStream(sink: StreamSink, broker: Broker): StreamSink {
  return {
    publishStarted: (run) =>
      publishLifecycle([sink.publishStarted(run), publishAgentRunActivity(broker, run)]),
    publishCompactionStarted: (input) => sink.publishCompactionStarted(input),
    publishCompactionCompleted: (input) => sink.publishCompactionCompleted(input),
    publishCompactionFailed: (input) => sink.publishCompactionFailed(input),
    publishUiChunk: (input) => sink.publishUiChunk(input),
    publishMessageFinalized: (input) => sink.publishMessageFinalized(input),
    publishRunFinished: (run) =>
      publishLifecycle([sink.publishRunFinished(run), publishAgentRunActivity(broker, run)]),
  }
}

async function publishLifecycle(deliveries: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(deliveries)
  const failure = results.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
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

  async publishCompactionStarted(input: CompactionStartedInput): Promise<void> {
    await this.publish({
      ...streamEventBase(this.projectId, input.run),
      type: "agent.compaction.started",
      reason: input.reason,
      estimatedInputTokensBefore: input.estimatedInputTokensBefore,
    })
  }

  async publishCompactionCompleted(input: CompactionCompletedInput): Promise<void> {
    await this.publish({
      ...streamEventBase(this.projectId, input.run),
      type: "agent.compaction.completed",
      reason: input.reason,
      checkpointId: input.checkpointId,
      estimatedInputTokensBefore: input.estimatedInputTokensBefore,
      estimatedInputTokensAfter: input.estimatedInputTokensAfter,
    })
  }

  async publishCompactionFailed(input: CompactionFailedInput): Promise<void> {
    await this.publish({
      ...streamEventBase(this.projectId, input.run),
      type: "agent.compaction.failed",
      reason: input.reason,
      errorCode: input.errorCode,
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
      chunk = toBrokerJson(input.chunk, "Agent stream chunk", {
        agentId: input.run.agentId,
        runId: input.run.id,
      })
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
      : toBrokerJson(event, "Agent stream event", {
          agentId: event.agentId,
          runId: event.runId,
        })
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

function streamEventBase(projectId: string, run: AgentRunRecord) {
  return {
    schemaVersion: AGENT_RUN_STREAM_SCHEMA_VERSION,
    projectId,
    runId: run.id,
    threadId: run.threadId,
    agentId: run.agentId,
    attempt: run.attempt,
    occurredAt: new Date().toISOString(),
  } as const
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

function toBrokerJson(
  value: unknown,
  label: string,
  details: { readonly agentId: string; readonly runId: string }
): JsonValue {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw createSixbError(
        "internal.unexpected",
        `[SixbAgentWorker] ${label} serialized to undefined.`,
        { details }
      )
    }
    // The stringify/parse round-trip already yields a pure JSON value (functions/symbols/undefined
    // are dropped or throw above, NaN/Infinity become null), so no further validation is needed —
    // the broker append boundary re-checks the payload anyway.
    return JSON.parse(serialized) as JsonValue
  } catch (error) {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] ${label} could not be JSON encoded.`,
      { cause: error, details }
    )
  }
}
