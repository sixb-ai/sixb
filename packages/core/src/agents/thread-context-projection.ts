import type { AgentContextCheckpointRecord, AgentMessageRecord } from "../storage/agents/types"
import type { AgentMessage } from "./message"

/** A model-only message. Persisted tail messages carry `id`; the synthetic summary does not. */
export interface AgentThreadModelContextMessage extends AgentMessage {
  readonly id?: string
}

export interface ProjectAgentThreadModelContextInput {
  readonly checkpoint: AgentContextCheckpointRecord | null
  /** Complete retained tail, ordered by ascending per-thread sequence. */
  readonly messages: readonly AgentMessageRecord[]
}

/**
 * Build the bounded, model-only view of a durable thread.
 *
 * The function is deliberately pure: storage chooses the latest checkpoint and reads its retained
 * tail; this function validates that projection and prepends one synthetic user-role summary.
 */
export function projectAgentThreadModelContext(
  input: ProjectAgentThreadModelContextInput
): readonly AgentThreadModelContextMessage[] {
  const { checkpoint, messages } = input
  if (!checkpoint) return messages

  assertConsistentCheckpointProjection(checkpoint, messages)
  return [
    {
      role: "user",
      parts: [{ type: "text", text: serializeThreadSummary(checkpoint.summary) }],
    },
    ...messages,
  ]
}

function assertConsistentCheckpointProjection(
  checkpoint: AgentContextCheckpointRecord,
  messages: readonly AgentMessageRecord[]
): void {
  if (checkpoint.summaryFormatVersion !== 1 || checkpoint.summary.trim().length === 0) {
    throw projectionError(checkpoint, "has an invalid summary")
  }
  if (checkpoint.summarizedThroughSeq >= checkpoint.observedHeadSeq) {
    throw projectionError(checkpoint, "does not retain its observed head")
  }
  if (messages.length === 0) {
    throw projectionError(checkpoint, "has no retained messages")
  }

  let expectedSeq = checkpoint.summarizedThroughSeq + 1
  for (const message of messages) {
    if (message.projectId !== checkpoint.projectId || message.threadId !== checkpoint.threadId) {
      throw projectionError(checkpoint, "contains a message from another thread")
    }
    if (message.seq !== expectedSeq) {
      throw projectionError(checkpoint, `has a sequence gap before message '${message.id}'`)
    }
    expectedSeq += 1
  }

  if (messages[0]?.role !== "user") {
    throw projectionError(checkpoint, "does not begin at a user turn boundary")
  }
  if ((messages.at(-1)?.seq ?? 0) < checkpoint.observedHeadSeq) {
    throw projectionError(checkpoint, "ends before the checkpoint's observed head")
  }
}

function serializeThreadSummary(summary: string): string {
  return [
    "The earlier conversation was compacted into this continuation summary.",
    "",
    "<sixb_thread_summary>",
    escapeXml(summary),
    "</sixb_thread_summary>",
  ].join("\n")
}

function projectionError(checkpoint: AgentContextCheckpointRecord, detail: string): Error {
  return new Error(
    `[Sixb] Agent context checkpoint '${checkpoint.id}' for thread '${checkpoint.threadId}' ${detail}.`
  )
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}
