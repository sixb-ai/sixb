import type { Broker, BrokerRecord } from "../../broker"
import type { ModelUiChunk } from "../../models/events"
import {
  type AgentRunStepsEvent,
  type AgentRunStepsRead,
  type AgentRunStreamEvent,
  agentRunStepsStreamId,
  isAgentRunStreamEvent,
} from "./protocol"

// A run's live stream carries one record per streamed delta, and drops its oldest past a limit: on
// its own it cannot rebuild a long turn. Its finished steps go to a stream of their own as well
// (see the stream sink), which a reader who opens the turn late reads first.

export type DeltaChunk = Extract<
  ModelUiChunk,
  { readonly type: "text-delta" | "reasoning-delta" | "tool-input-delta" }
>

export function isDeltaChunk(chunk: ModelUiChunk): chunk is DeltaChunk {
  return (
    chunk.type === "text-delta" ||
    chunk.type === "reasoning-delta" ||
    chunk.type === "tool-input-delta"
  )
}

/** Whether `next` extends `delta`'s span, so the two read as one delta. */
export function continuesDelta(delta: DeltaChunk, next: ModelUiChunk): next is DeltaChunk {
  if (next.type !== delta.type) return false
  if (delta.type === "tool-input-delta") {
    return next.type === "tool-input-delta" && next.toolCallId === delta.toolCallId
  }
  return (next as { readonly id?: string }).id === delta.id
}

export function mergeDeltas(delta: DeltaChunk, next: DeltaChunk): DeltaChunk {
  if (delta.type === "tool-input-delta" && next.type === "tool-input-delta") {
    return { ...delta, inputTextDelta: delta.inputTextDelta + next.inputTextDelta }
  }
  if (delta.type !== "tool-input-delta" && next.type !== "tool-input-delta") {
    return { ...delta, delta: delta.delta + next.delta }
  }
  return delta
}

/** Appends `chunk`, merged into the last chunk when it extends the same span. */
export function appendCompacted(chunks: ModelUiChunk[], chunk: ModelUiChunk): void {
  const last = chunks.at(-1)
  if (last && isDeltaChunk(last) && continuesDelta(last, chunk)) {
    chunks[chunks.length - 1] = mergeDeltas(last, chunk)
    return
  }
  chunks.push(chunk)
}

/**
 * A run's finished steps for one attempt, as one event, or null when none finished yet. Records of
 * an earlier attempt are left out: that attempt's work was redone.
 */
export async function readAgentRunSteps(
  broker: Broker,
  params: { readonly projectId: string; readonly runId: string; readonly attempt: number }
): Promise<AgentRunStepsEvent | null> {
  const streamId = agentRunStepsStreamId(params.runId)
  const records: BrokerRecord[] = []
  let afterCursor: string | undefined
  for (;;) {
    const page = await broker.read({
      projectId: params.projectId,
      streamId,
      ...(afterCursor === undefined ? {} : { afterCursor }),
      limit: 1_000,
    })
    records.push(...page.records)
    afterCursor = page.cursor ?? afterCursor
    if (!page.hasMore || page.records.length === 0) break
  }

  let last: AgentRunStepsEvent | null = null
  const chunks: ModelUiChunk[] = []
  const reads: AgentRunStepsRead[] = []
  for (const record of records) {
    const event = record.payload as unknown
    if (!isStepsEvent(event) || event.attempt !== params.attempt) continue

    // Each step's reads keep their place among its chunks once the steps are joined.
    const offset = chunks.length
    const stepReads = event.reads ?? []
    for (const read of stepReads) reads.push({ ...read, at: read.at + offset })

    event.chunks.forEach((chunk, index) => {
      // A chunk right after a read is not merged into the one before it: the read sits between.
      const afterRead = reads.at(-1)?.at === offset + index
      if (afterRead || index > 0) chunks.push(chunk)
      else appendCompacted(chunks, chunk)
    })
    last = event
  }
  if (last === null) return null

  const { reads: _lastReads, ...base } = last
  return { ...base, chunks, ...(reads.length === 0 ? {} : { reads }) }
}

function isStepsEvent(value: unknown): value is AgentRunStepsEvent {
  return isAgentRunStreamEvent(value) && (value as AgentRunStreamEvent).type === "agent.ui.steps"
}

/** Whether a live record is a chunk or a read that `steps` already holds. */
export function coveredBySteps(steps: AgentRunStepsEvent, payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false
  const event = payload as {
    readonly type?: unknown
    readonly attempt?: unknown
    readonly chunkIndex?: unknown
    readonly afterChunkIndex?: unknown
  }
  if (event.attempt !== steps.attempt) return false

  if (event.type === "agent.ui.chunk") {
    return typeof event.chunkIndex === "number" && event.chunkIndex <= steps.throughChunkIndex
  }

  // A read before the turn's first chunk opens its first step, which every steps event holds.
  if (event.type === "agent.inbox.read") {
    const after = typeof event.afterChunkIndex === "number" ? event.afterChunkIndex : -1
    return after <= steps.throughChunkIndex
  }
  return false
}
