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
  /**
   * Whether the run reading the thread can print its stored messages with `sixb history`, as a
   * conversation's turn can, for its summary to say so. A child's run cannot. True when left out.
   */
  readonly historyReadable?: boolean
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
  const summary = serializeThreadSummary(checkpoint.summary, input.historyReadable ?? true)
  return [{ role: "user", parts: [{ type: "text", text: summary }] }, ...messages]
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

const SUMMARY_INTRO = "The earlier conversation was compacted into this continuation summary."

/**
 * Whether a user message's text is the summary this projection writes, for a context meter to
 * name it: a message a user typed the same way would count as one there, and nowhere else.
 */
export function isAgentThreadSummaryText(text: string): boolean {
  return text.startsWith(SUMMARY_INTRO) && text.includes("\n<sixb_thread_summary>\n")
}

function serializeThreadSummary(summary: string, historyReadable: boolean): string {
  return [
    historyReadable
      ? `${SUMMARY_INTRO} Its messages are still stored: \`sixb history\` prints them.`
      : SUMMARY_INTRO,
    "",
    "<sixb_thread_summary>",
    escapeXmlText(summary),
    "</sixb_thread_summary>",
  ].join("\n")
}

function projectionError(checkpoint: AgentContextCheckpointRecord, detail: string): Error {
  return new Error(
    `[Sixb] Agent context checkpoint '${checkpoint.id}' for thread '${checkpoint.threadId}' ${detail}.`
  )
}

/** Text inside a tag: quotes stay as written, so the summary reads as the model wrote it. */
function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
