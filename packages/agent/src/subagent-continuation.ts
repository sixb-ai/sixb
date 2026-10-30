import type { AgentMessagePart } from "@sixb/core"
import type { AgentMessageRecord, SubagentRunRecord } from "@sixb/core/storage"
import { renderCurrentTime } from "./agent-prompt"
import { mailPart } from "./subagent-inbox"

// A child that paused continues as the next run of its thread under a later turn: once its held
// calls are decided, in the turn that resumes, or once its parent answers the question it paused
// on, in the turn the parent answers it. The same key, model and task. Its history is its thread,
// and what it goes on with is the message that starts the run.

/** What a child run reads of its thread: its messages, and the paused run it continues (`AgentChildContext`). */
export interface SubagentHistory {
  readonly messages: readonly AgentMessageRecord[]
  /** The run of the thread that paused on its held calls, when this run continues it. */
  readonly paused?: SubagentRunRecord
}

/**
 * The message a continuation starts with: how each of its calls ended, as its own, or its parent's
 * answer to its question; the messages its parent sent that the paused run never read; what came
 * back to its new sandbox, and when it continues. It stays in
 * the thread, so a later continuation replays the same bytes.
 *
 * A child whose workspace is kept finds it as it left it, and is told nothing about it here. If
 * its files turn out lost, its system prompt says so, as a turn's does.
 */
export function continuationTrigger(input: {
  /** The outcomes as the child reads them, without their caller, or the answer's `mail` part. */
  readonly goesOnWith: readonly AgentMessagePart[]
  readonly paused: SubagentRunRecord
  /** Whether the sandbox provider keeps the child's workspace while it pauses. */
  readonly keepsWorkspace: boolean
  readonly createdAt: Date
  readonly timeZone: string
}): readonly AgentMessagePart[] {
  return [
    ...input.goesOnWith,
    ...(input.paused.result?.unread ?? []).map((mail) => mailPart(mail)),
    ...(input.keepsWorkspace
      ? []
      : [{ type: "text" as const, text: sandboxRestarted(input.paused) }]),
    { type: "text", text: `\n\n${renderCurrentTime(input.createdAt, input.timeZone)}` },
  ]
}

function sandboxRestarted(paused: SubagentRunRecord): string {
  const outputsError = paused.result?.filesError
  return outputsError === undefined
    ? "Your sandbox restarted: the files you were handed and your out/ are back; nothing else is."
    : `Your sandbox restarted: the files you were handed are back, but not your out/, which could not be kept (${outputsError}). Nothing else is.`
}
