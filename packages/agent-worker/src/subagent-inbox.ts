import {
  type AgentMailPart,
  type AgentMessage,
  AgentToolPublicError,
  type Broker,
} from "@sixb/core"
import {
  isKnownAgentMailKind,
  publishAgentMail,
  readAgentMail,
  subscribeAgentMail,
} from "@sixb/core/internal/agents"
import type { SubagentRunRecord } from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import type { QuestionRef } from "./child-questions"

/** Messages the child read, and where it read them: after how many of its steps. */
export interface SubagentDelivery {
  readonly afterSteps: number
  readonly parts: readonly AgentMailPart[]
}

/** How its parent replied to the child's question: its answer, or none before its turn ended. */
export type ParentReply =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "deferred"; readonly questionId: string }

/** Replies to the child's questions: `ask`'s, never read as messages. */
const REPLY_KINDS: ReadonlySet<string> = new Set(["answer", "deferred"])

/**
 * What a child's parent sent it, read at each of its step boundaries (`take`) from its thread's
 * inbox, and the questions it asks its parent (`ask`). The broker keeps the order; the inbox keeps
 * each message once by its id, whatever the broker delivers again, and skips what its thread
 * already holds. What it read is the child's to record: its thread keeps each delivery where the
 * model read it, and each question as its tool call.
 *
 * Every run of the child reads the same inbox, so a continuation reads at its first step what was
 * sent to the paused run and never read: a message accepted just before it paused still reaches
 * the child that goes on.
 */
export class SubagentInbox {
  #cursor: string | undefined
  readonly #read: Set<string>
  readonly #deliveries: SubagentDelivery[] = []
  /** The question waiting for its reply: one at a time. */
  #asking: string | undefined
  #deferred: QuestionRef | undefined

  constructor(
    private readonly broker: Broker,
    private readonly run: SubagentRunRecord,
    /** The child's thread so far: what its earlier runs read is there. */
    thread: readonly Pick<AgentMessage, "parts">[]
  ) {
    this.#read = new Set(
      thread.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === "mail" ? [part.id] : []))
      )
    )
  }

  /** What the child read, in order. */
  get deliveries(): readonly SubagentDelivery[] {
    return this.#deliveries
  }

  /** The question its parent's turn ended without answering: the child pauses on it. */
  get deferred(): QuestionRef | undefined {
    return this.#deferred
  }

  /**
   * Ask the parent and wait for its reply, bounded by `signal`: the child's own cancel, its
   * parent's, and its deadline. Its id names the child's model call and tool call, so the parent
   * lists it once. The first reply counts, whatever the broker delivers again.
   */
  async ask(question: string, callId: string, signal: AbortSignal): Promise<ParentReply> {
    if (this.#asking !== undefined) {
      throw new AgentToolPublicError(
        "[SixbAgentWorker] Ask one question at a time: your parent has not answered the last one yet."
      )
    }
    signal.throwIfAborted()

    const { projectId, id: runId, threadId, parentRunId } = this.run
    const id = `${runId}:${callId}`
    this.#asking = id
    let replied!: (reply: ParentReply) => void
    const reply = new Promise<ParentReply>((resolve) => {
      replied = resolve
    })
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = await subscribeAgentMail(
        this.broker,
        { projectId, inbox: { threadId } },
        (mail) => {
          const found = mail.find(
            (item) =>
              item.fromRunId === parentRunId && item.inReplyTo === id && REPLY_KINDS.has(item.kind)
          )
          if (found?.kind === "answer") replied({ kind: "answer", text: found.text })
          if (found?.kind === "deferred") replied({ kind: "deferred", questionId: id })
        }
      )
      await publishAgentMail(this.broker, {
        projectId,
        mail: {
          id,
          fromRunId: runId,
          fromThreadId: threadId,
          toRunId: parentRunId,
          kind: "question",
          text: question,
          sentAt: new Date().toISOString(),
        },
      })

      const settled = await waitForAbort(reply, signal)
      if (settled.kind === "deferred") this.#deferred = { id, text: question }
      return settled
    } finally {
      unsubscribe?.()
      this.#asking = undefined
    }
  }

  /**
   * The messages that came since the last read, as the user message the child reads after
   * `afterSteps` of its steps; none when nothing came. `afterAnswer` when the child just answered:
   * it is told to write its result again in full. A read that fails is tried again at the next
   * boundary, from the same place.
   */
  async take(
    afterSteps: number,
    options: { readonly afterAnswer?: boolean } = {}
  ): Promise<AgentMessage | undefined> {
    const { projectId, id: runId, threadId } = this.run
    let page: Awaited<ReturnType<typeof readAgentMail>>
    try {
      page = await readAgentMail(this.broker, {
        projectId,
        inbox: { threadId },
        ...(this.#cursor === undefined ? {} : { afterCursor: this.#cursor }),
      })
    } catch (error) {
      console.error(
        `[SixbAgentWorker] Subagent run '${runId}' could not read its inbox; it reads it again at its next step.`,
        error
      )
      return undefined
    }
    this.#cursor = page.cursor ?? this.#cursor

    const parts: AgentMailPart[] = []
    for (const mail of page.mail) {
      if (this.#read.has(mail.id) || REPLY_KINDS.has(mail.kind)) continue

      this.#read.add(mail.id)
      if (!isKnownAgentMailKind(mail.kind)) {
        // A newer sender's kind: its text still reaches the model, as a message.
        console.warn(
          `[SixbAgentWorker] Subagent run '${runId}' read mail '${mail.id}' of unknown kind '${mail.kind}'; its text reads as a message.`
        )
      }
      parts.push({
        type: "mail",
        id: mail.id,
        from: "parent",
        kind: "message",
        text: mail.text,
        ...(options.afterAnswer ? { afterAnswer: true as const } : {}),
      })
    }
    if (parts.length === 0) return undefined

    this.#deliveries.push({ afterSteps, parts })
    return { role: "user", parts }
  }
}
