import type { Broker, BrokerStreamDefinition } from "../broker"
import { createSixbError } from "../errors/internal"
import type { JsonValue } from "../json"
import type {
  AgentContextCheckpointReason,
  AgentRunRecord,
  ConversationAgentRunRecord,
} from "../storage/agents"
import type {
  AgentCompactionFailureCode,
  AgentInboxReadMessage,
  AgentRunStepsRead,
  AgentRunStreamEvent,
  ModelUiChunk,
} from "./streams"
import {
  agentRunFinishedEvent,
  agentRunStepsStreamDefinition,
  agentRunStepsStreamId,
  agentRunStreamDefinition,
  agentRunStreamEventBase,
  agentRunStreamId,
  agentRunStreamIdempotencyKey,
  publishAgentRunActivity,
} from "./streams/protocol"
import {
  appendCompacted,
  continuesDelta,
  type DeltaChunk,
  isDeltaChunk,
  mergeDeltas,
} from "./streams/steps"

export interface CompactionStartedInput {
  /** A conversation's turn, or a child compacting its own thread. */
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
    readonly chunk: ModelUiChunk
  }): Promise<void>
  /** Messages a turn read from its thread's inbox, in the stream where it read them. */
  publishInboxRead(input: {
    readonly run: ConversationAgentRunRecord
    readonly messages: readonly AgentInboxReadMessage[]
  }): Promise<void>
  publishMessageFinalized(input: {
    readonly run: ConversationAgentRunRecord
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
  async publishInboxRead() {},
  async publishMessageFinalized() {},
  async publishRunFinished() {},
}

/** Creates the default sink backed by Sixb's broker stream contract. */
export function createBrokerStreamSink(input: {
  readonly broker: Broker
  readonly projectId: string
  /** How long deltas of one span wait to go out as one record; 0 publishes each as it comes. */
  readonly deltaWindowMs?: number
}): StreamSink {
  return new BrokerStreamSink(
    input.broker,
    input.projectId,
    input.deltaWindowMs ?? AGENT_RUN_STREAM_DELTA_WINDOW_MS
  )
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
    publishInboxRead: (input) =>
      isolateStreamSinkCall(input.run.id, "inbox read", () => sink.publishInboxRead(input)),
    publishMessageFinalized: (input) =>
      isolateStreamSinkCall(input.run.id, "message finalized", () =>
        sink.publishMessageFinalized(input)
      ),
    publishRunFinished: (run) =>
      isolateStreamSinkCall(run.id, "run finished", () => sink.publishRunFinished(run)),
  }
}

/**
 * Keep the lifecycle feed platform-owned even when callers replace transcript streaming: a
 * conversation's on the project's activity feed.
 */
export function withAgentActivityStream(sink: StreamSink, broker: Broker): StreamSink {
  return {
    publishStarted: (run) =>
      publishLifecycle([
        sink.publishStarted(run),
        ...(run.kind === "conversation" ? [publishAgentRunActivity(broker, run)] : []),
      ]),
    publishCompactionStarted: (input) => sink.publishCompactionStarted(input),
    publishCompactionCompleted: (input) => sink.publishCompactionCompleted(input),
    publishCompactionFailed: (input) => sink.publishCompactionFailed(input),
    publishUiChunk: (input) => sink.publishUiChunk(input),
    publishInboxRead: (input) => sink.publishInboxRead(input),
    publishMessageFinalized: (input) => sink.publishMessageFinalized(input),
    publishRunFinished: (run) =>
      publishLifecycle([
        sink.publishRunFinished(run),
        ...(run.kind === "conversation" ? [publishAgentRunActivity(broker, run)] : []),
      ]),
  }
}

async function publishLifecycle(deliveries: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(deliveries)
  const failure = results.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
}

/** How long the deltas of one span wait to go out as one record. */
export const AGENT_RUN_STREAM_DELTA_WINDOW_MS = 50

/** Runs one sink keeps stream state for at once: one that never finished here is dropped first. */
const MAX_TRACKED_RUNS = 256

/** What a sink keeps about one run while it streams. */
interface RunStream {
  readonly attempt: number
  /** Every record of the run goes out through this chain, so they keep their order. */
  tail: Promise<void>
  /** Deltas of one span not published yet, under the index of the first. */
  pending: {
    run: AgentRunRecord
    readonly chunkIndex: number
    chunk: DeltaChunk
  } | null
  timer: ReturnType<typeof setTimeout> | undefined
  /** The chunks published since the last step was logged, compacted. */
  step: ModelUiChunk[]
  /** What the turn read from its inbox since then, each after the first `at` chunks of `step`. */
  reads: AgentRunStepsRead[]
  /** The index of the last chunk published. */
  lastChunkIndex: number | undefined
}

class BrokerStreamSink implements StreamSink {
  private readonly ensured = new Set<string>()
  private readonly runs = new Map<string, RunStream>()

  constructor(
    private readonly broker: Broker,
    private readonly projectId: string,
    private readonly deltaWindowMs: number
  ) {}

  async publishStarted(run: AgentRunRecord): Promise<void> {
    await this.publishInOrder(run, {
      ...agentRunStreamEventBase(run),
      type: "agent.run.started",
      ...(run.modelId === undefined ? {} : { modelId: run.modelId }),
    })
  }

  async publishCompactionStarted(input: CompactionStartedInput): Promise<void> {
    await this.publishInOrder(input.run, {
      ...agentRunStreamEventBase(input.run),
      type: "agent.compaction.started",
      reason: input.reason,
      estimatedInputTokensBefore: input.estimatedInputTokensBefore,
    })
  }

  async publishCompactionCompleted(input: CompactionCompletedInput): Promise<void> {
    await this.publishInOrder(input.run, {
      ...agentRunStreamEventBase(input.run),
      type: "agent.compaction.completed",
      reason: input.reason,
      checkpointId: input.checkpointId,
      estimatedInputTokensBefore: input.estimatedInputTokensBefore,
      estimatedInputTokensAfter: input.estimatedInputTokensAfter,
    })
  }

  async publishCompactionFailed(input: CompactionFailedInput): Promise<void> {
    await this.publishInOrder(input.run, {
      ...agentRunStreamEventBase(input.run),
      type: "agent.compaction.failed",
      reason: input.reason,
      errorCode: input.errorCode,
    })
  }

  /**
   * Publishes one live UI chunk. Deltas of one span arriving within the window go out as one record:
   * a model streams a few characters per delta, far more often than anyone reads. Anything else
   * first sends the deltas held, and is awaited, so broker backpressure throttles the token stream.
   */
  async publishUiChunk(input: {
    readonly run: AgentRunRecord
    readonly chunkIndex: number
    readonly chunk: ModelUiChunk
  }): Promise<void> {
    let chunk: ModelUiChunk
    try {
      // The round-trip keeps the chunk's shape: every field of a chunk is JSON by type.
      chunk = toBrokerJson(input.chunk, "Agent stream chunk", {
        runId: input.run.id,
      }) as ModelUiChunk
    } catch (error) {
      console.error("[Sixb] Agent run stream chunk encoding failed:", error)
      return
    }

    const stream = this.stream(input.run)
    const pending = stream.pending
    if (pending && continuesDelta(pending.chunk, chunk)) {
      pending.chunk = mergeDeltas(pending.chunk, chunk)
      pending.run = input.run
      return
    }

    const flushed = this.flush(stream)
    if (isDeltaChunk(chunk) && this.deltaWindowMs > 0) {
      stream.pending = { run: input.run, chunkIndex: input.chunkIndex, chunk }
      stream.timer = setTimeout(() => void this.flush(stream), this.deltaWindowMs)
      await flushed
      return
    }
    await this.enqueue(stream, () => this.appendChunk(input.run, stream, input.chunkIndex, chunk))
  }

  /**
   * Publishes what the turn read, after every chunk it streamed before. Its step keeps it too, so
   * whoever opens the turn later reads it where the turn did.
   */
  async publishInboxRead(input: {
    readonly run: ConversationAgentRunRecord
    readonly messages: readonly AgentInboxReadMessage[]
  }): Promise<void> {
    const stream = this.stream(input.run)
    void this.flush(stream)

    await this.enqueue(stream, async () => {
      const afterChunkIndex = stream.lastChunkIndex
      await this.publish({
        ...agentRunStreamEventBase(input.run),
        type: "agent.inbox.read",
        messages: input.messages,
        ...(afterChunkIndex === undefined ? {} : { afterChunkIndex }),
      })

      stream.reads.push({ at: stream.step.length, messages: input.messages })
    })
  }

  async publishMessageFinalized(input: {
    readonly run: ConversationAgentRunRecord
    readonly messageId: string
  }): Promise<void> {
    await this.publishInOrder(input.run, {
      ...agentRunStreamEventBase(input.run),
      type: "agent.message.finalized",
      messageId: input.messageId,
    })
  }

  async publishRunFinished(run: AgentRunRecord): Promise<void> {
    if (run.status === "queued" || run.status === "running") {
      return
    }
    try {
      await this.publishInOrder(run, agentRunFinishedEvent(run))
    } finally {
      // This is the last event for the run: drop what the sink kept for it, to bound a long-lived
      // worker's memory.
      this.forget(run.id)
    }
  }

  /** The run's stream state, started over for a new attempt. */
  private stream(run: AgentRunRecord): RunStream {
    const known = this.runs.get(run.id)
    if (known && known.attempt === run.attempt) return known
    if (known) clearTimeout(known.timer)
    else if (this.runs.size >= MAX_TRACKED_RUNS) {
      const [oldest] = this.runs.keys()
      if (oldest !== undefined) this.forget(oldest)
    }

    const stream: RunStream = {
      attempt: run.attempt,
      tail: Promise.resolve(),
      pending: null,
      timer: undefined,
      step: [],
      reads: [],
      lastChunkIndex: undefined,
    }
    this.runs.set(run.id, stream)
    return stream
  }

  private forget(runId: string): void {
    clearTimeout(this.runs.get(runId)?.timer)
    this.runs.delete(runId)
    this.ensured.delete(agentRunStreamId(runId))
    this.ensured.delete(agentRunStepsStreamId(runId))
  }

  /** Runs `task` after every record the run sent before it. */
  private enqueue(stream: RunStream, task: () => Promise<void>): Promise<void> {
    const next = stream.tail.then(task)
    stream.tail = next.catch(() => {})
    return next
  }

  /** Sends the deltas held, if any. Never rejects: a failed send is logged, as for any chunk. */
  private flush(stream: RunStream): Promise<void> {
    clearTimeout(stream.timer)
    stream.timer = undefined
    const pending = stream.pending
    if (!pending) return stream.tail
    stream.pending = null
    return this.enqueue(stream, () =>
      this.appendChunk(pending.run, stream, pending.chunkIndex, pending.chunk)
    ).catch((error: unknown) => {
      console.error(`[Sixb] Agent run '${pending.run.id}' ui chunk stream publish failed:`, error)
    })
  }

  private async publishInOrder(run: AgentRunRecord, event: AgentRunStreamEvent): Promise<void> {
    const stream = this.stream(run)
    void this.flush(stream)
    await this.enqueue(stream, () => this.publish(event))
  }

  private async appendChunk(
    run: AgentRunRecord,
    stream: RunStream,
    chunkIndex: number,
    chunk: ModelUiChunk
  ): Promise<void> {
    const startsStep = chunk.type === "start-step" && !chunk.retry
    // A new step: the one before is finished, and logged for whoever opens the turn later.
    if (startsStep && (stream.step.length > 0 || stream.reads.length > 0)) {
      await this.logStep(run, stream)
    }

    // `chunk` is already validated JSON and every other field is a JSON primitive, so the event is
    // JSON as-built. Publish it pre-validated so the chunk — the highest-frequency agent event — is
    // not serialized a second time inside `publish`.
    await this.publish(
      {
        ...agentRunStreamEventBase(run),
        type: "agent.ui.chunk",
        chunkIndex,
        chunk,
      },
      { prevalidated: true }
    )

    stream.lastChunkIndex = chunkIndex
    if (chunk.type === "start-step" && chunk.retry) {
      // A step asked again drops what its first call streamed, as a reader does. What the turn read
      // as the step started stays: the step reads it again.
      const [head] = stream.step
      stream.step = head?.type === "start-step" ? [head] : []
      stream.reads = stream.reads.filter((read) => read.at <= stream.step.length)
      return
    }

    // A chunk after a read starts a span of its own: the read sits between the two.
    if (stream.reads.at(-1)?.at === stream.step.length) stream.step.push(chunk)
    else appendCompacted(stream.step, chunk)
  }

  /**
   * Appends the chunks since the last step logged to the run's steps stream. A failed append keeps
   * them, so they go out with the next step: the live record is published either way.
   */
  private async logStep(run: AgentRunRecord, stream: RunStream): Promise<void> {
    if (stream.lastChunkIndex === undefined) return
    const event: AgentRunStreamEvent = {
      ...agentRunStreamEventBase(run),
      type: "agent.ui.steps",
      throughChunkIndex: stream.lastChunkIndex,
      chunks: stream.step,
      ...(stream.reads.length === 0 ? {} : { reads: stream.reads }),
    }
    try {
      const definition = agentRunStepsStreamDefinition(run.id)
      await this.ensure(definition)
      await this.broker.append({
        projectId: this.projectId,
        streamId: definition.id,
        records: [
          {
            name: event.type,
            key: run.id,
            // Its chunks were validated as they were published.
            payload: event as unknown as JsonValue,
            idempotencyKey: agentRunStreamIdempotencyKey(event),
          },
        ],
      })
      stream.step = []
      stream.reads = []
    } catch (error) {
      console.error(`[Sixb] Agent run '${run.id}' step log publish failed:`, error)
    }
  }

  private async publish(
    event: AgentRunStreamEvent,
    options: { readonly prevalidated?: boolean } = {}
  ): Promise<void> {
    await this.ensure(agentRunStreamDefinition(event.runId))
    // Broker payloads are plain JSON; keep SDK-specific chunk shapes opaque at this boundary. A
    // pre-validated event (its only opaque field, the chunk, was already encoded by the caller) is
    // already JSON, so it is forwarded as-is instead of being serialized a second time.
    const payload = options.prevalidated
      ? (event as unknown as JsonValue)
      : toBrokerJson(event, "Agent stream event", {
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

  private async ensure(stream: BrokerStreamDefinition): Promise<void> {
    if (this.ensured.has(stream.id)) {
      return
    }
    await this.broker.ensureStream({ projectId: this.projectId, stream })
    this.ensured.add(stream.id)
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
    console.error(`[Sixb] Agent run '${runId}' ${label} stream publish failed:`, error)
  }
}

function toBrokerJson(
  value: unknown,
  label: string,
  details: { readonly runId: string }
): JsonValue {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw createSixbError("internal.unexpected", `[Sixb] ${label} serialized to undefined.`, {
        details,
      })
    }
    // The stringify/parse round-trip already yields a pure JSON value (functions/symbols/undefined
    // are dropped or throw above, NaN/Infinity become null), so no further validation is needed —
    // the broker append boundary re-checks the payload anyway.
    return JSON.parse(serialized) as JsonValue
  } catch (error) {
    throw createSixbError("internal.unexpected", `[Sixb] ${label} could not be JSON encoded.`, {
      cause: error,
      details,
    })
  }
}
