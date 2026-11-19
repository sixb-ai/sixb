import type { AgentMessagePart } from "@sixb/core"
import type { AgentTurnHistory } from "@sixb/core/internal/agents"
import type { AgentMessageRecord, SubagentRunRecord } from "@sixb/core/storage"
import { renderCurrentTime, type SentSettings } from "./agent-prompt"
import { mailPart } from "./subagent-inbox"

// A child that paused continues as the next run of its thread under a later turn: once its held
// calls are decided, in the turn that resumes, or once its parent answers the question it paused
// on, in the turn the parent answers it. The same key, model and task. Its history is its thread,
// and what it goes on with is the message that starts the run.

/**
 * What a child run reads of its thread (`AgentChildContext`): its latest checkpoint and the
 * messages after it, its task when the checkpoint summarized it, and the paused run it continues.
 */
export interface SubagentHistory extends AgentTurnHistory {
  /** The thread's first message, when a checkpoint summarized it: its requests keep it as it is. */
  readonly task?: AgentMessageRecord
  /** The run of the thread that paused on its held calls, when this run continues it. */
  readonly paused?: SubagentRunRecord
}

/**
 * The message a continuation starts with: how each of its calls ended, as its own, or its parent's
 * answer to its question; the messages its parent sent that the paused run never read; what came
 * back to its new sandbox, and when it continues. It stays in
 * the thread, so a later continuation replays the same bytes.
 *
 * A child whose workspace is kept, its own or its parent's, finds it as it left it, and is told
 * nothing about it here. If its own workspace's files turn out lost, its system prompt says so, as
 * a turn's does; if its parent's was recreated after it paused, this message says so.
 */
export function continuationTrigger(input: {
  /** The outcomes as the child reads them, without their caller, or the answer's `mail` part. */
  readonly goesOnWith: readonly AgentMessagePart[]
  readonly paused: SubagentRunRecord
  readonly workspace: ContinuationWorkspace
  readonly createdAt: Date
  readonly settings: SentSettings
}): readonly AgentMessagePart[] {
  const told =
    input.workspace === "restarted"
      ? sandboxRestarted(input.paused)
      : input.workspace === "left-parent"
        ? LEFT_PARENT_WORKSPACE
        : input.workspace === "parent-reset"
          ? PARENT_WORKSPACE_RESET
          : undefined

  return [
    ...input.goesOnWith,
    ...(input.paused.result?.unread ?? []).map((mail) => mailPart(mail)),
    ...(told === undefined ? [] : [{ type: "text" as const, text: told }]),
    { type: "text", text: `\n\n${renderCurrentTime(input.createdAt, input.settings)}` },
  ]
}

/**
 * Where a paused child continues: in its parent's workspace again, as it left it (`parent`) or
 * recreated since (`parent-reset`); in its own sandbox, kept as it left it (`kept`) or started
 * again (`restarted`); or, after working in its parent's workspace, in a blank sandbox of its own
 * (`left-parent`), as once the conversation moved.
 */
export type ContinuationWorkspace = "parent" | "parent-reset" | "kept" | "restarted" | "left-parent"

/** Whether a continuation runs in its parent's workspace, which the turn lends it. */
export function continuesInParentWorkspace(workspace: ContinuationWorkspace): boolean {
  return workspace === "parent" || workspace === "parent-reset"
}

const PARENT_WORKSPACE_RESET =
  "Your parent's workspace was recreated while you were paused: the changes you made there are gone. You still work in it, on its files as they are now: inspect them before relying on earlier tool results."

const LEFT_PARENT_WORKSPACE =
  "You no longer work in your parent's workspace: you continue in a blank sandbox of your own, and the changes you made there are not here."

function sandboxRestarted(paused: SubagentRunRecord): string {
  const outputsError = paused.result?.filesError
  return outputsError === undefined
    ? "Your sandbox restarted: the files you were handed and your out/ are back; nothing else is."
    : `Your sandbox restarted: the files you were handed are back, but not your out/, which could not be kept (${outputsError}). Nothing else is.`
}
