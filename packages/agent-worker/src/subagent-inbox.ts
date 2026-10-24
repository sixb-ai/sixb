import type { AgentMailPart, AgentMessage, Broker } from "@sixb/core"
import { isKnownAgentMailKind, readAgentMail } from "@sixb/core/internal/agents"
import type { SubagentRunRecord } from "@sixb/core/storage"

/** Messages the child read, and where it read them: after how many of its steps. */
export interface SubagentDelivery {
  readonly afterSteps: number
  readonly parts: readonly AgentMailPart[]
}

/**
 * What a child's parent sent it, read at each of its step boundaries (`take`) from its thread's
 * inbox. The broker keeps the order; the inbox keeps each message once by its id, whatever the
 * broker delivers again, and skips what its thread already holds. What it read is the child's to
 * record: its thread keeps each delivery where the model read it.
 *
 * Every run of the child reads the same inbox, so a continuation reads at its first step what was
 * sent to the paused run and never read: a message accepted just before it paused still reaches
 * the child that goes on.
 */
export class SubagentInbox {
  #cursor: string | undefined
  readonly #read: Set<string>
  readonly #deliveries: SubagentDelivery[] = []

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
      if (this.#read.has(mail.id)) continue

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
