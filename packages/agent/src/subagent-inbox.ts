import { type AgentMailPart, type AgentMessage, AgentToolPublicError } from "@sixb/core"
import type { SubagentRunRecord } from "@sixb/core/storage"
import type { QuestionRef } from "./child-questions"
import type { ChildMailbox, UnreadChildMail } from "./family-mailbox"

/** Messages the child read, and where it read them: after how many of its steps. */
export interface SubagentDelivery {
  readonly afterSteps: number
  readonly parts: readonly AgentMailPart[]
}

/** How its parent replied to the child's question: its answer, or none before its turn ended. */
export type ParentReply =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "deferred"; readonly questionId: string }

/**
 * What a child's parent sent it, read at each of its step boundaries (`take`) from its side of the
 * turn's mailbox, and the questions it asks its parent (`ask`). What it read is the child's to
 * record: its thread keeps each delivery where the model read it, and each question as its tool
 * call. What it never read when it pauses is returned by `close`, for the run that continues it.
 */
export class SubagentInbox {
  readonly #deliveries: SubagentDelivery[] = []
  /** The question waiting for its reply: one at a time. */
  #asking: string | undefined
  #deferred: QuestionRef | undefined

  constructor(
    private readonly mailbox: ChildMailbox,
    private readonly run: SubagentRunRecord
  ) {}

  /** What the child read, in order. */
  get deliveries(): readonly SubagentDelivery[] {
    return this.#deliveries
  }

  /** The question its parent's turn ended without answering: the child pauses on it. */
  get deferred(): QuestionRef | undefined {
    return this.#deferred
  }

  /**
   * Ask the parent and wait for its reply, bounded by `signal`: the child's own cancel and its
   * parent's. Its id names the child's model call and tool call, so the parent lists it once.
   */
  async ask(question: string, callId: string, signal: AbortSignal): Promise<ParentReply> {
    if (this.#asking !== undefined) {
      throw new AgentToolPublicError(
        "[SixbAgent] Ask one question at a time: your parent has not answered the last one yet."
      )
    }
    const id = `${this.run.id}:${callId}`
    this.#asking = id
    try {
      const reply = await this.mailbox.ask({ id, text: question }, signal)
      if (reply.kind === "answer") return { kind: "answer", text: reply.text }
      this.#deferred = { id, text: question }
      return { kind: "deferred", questionId: id }
    } finally {
      this.#asking = undefined
    }
  }

  /**
   * The messages that came since the last read, as the user message the child reads after
   * `afterSteps` of its steps; none when nothing came. `afterAnswer` when the child just answered:
   * it is told to write its result again in full.
   */
  take(
    afterSteps: number,
    options: { readonly afterAnswer?: boolean } = {}
  ): AgentMessage | undefined {
    const parts = this.mailbox.take().map((mail) => mailPart(mail, options))
    if (parts.length === 0) return undefined

    this.#deliveries.push({ afterSteps, parts })
    return { role: "user", parts }
  }

  /** Stop reading, as the child stops: what it never read, for the run that continues it. */
  close(): readonly UnreadChildMail[] {
    return this.mailbox.close()
  }
}

/** A message from the parent, as the child's thread keeps it where the child read it. */
export function mailPart(
  mail: UnreadChildMail,
  options: { readonly afterAnswer?: boolean } = {}
): AgentMailPart {
  return {
    type: "mail",
    id: mail.id,
    from: "parent",
    kind: "message",
    text: mail.text,
    ...(options.afterAnswer ? { afterAnswer: true as const } : {}),
  }
}
