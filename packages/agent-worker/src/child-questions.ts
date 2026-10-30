import type { AgentRunMail, ReceivedAgentMail } from "@sixb/core/internal/agents"

/**
 * A question a child asked: the id of its mail and what it asks. A child paused on it keeps both in
 * its thread, the text as its `ask_parent` call's input and the id in that call's output.
 */
export interface QuestionRef {
  readonly id: string
  readonly text: string
}

/** A question a child of the turn asked. */
export interface ChildQuestion extends QuestionRef {
  /** The child that asked it, waiting for the answer. */
  readonly runId: string
}

/**
 * The questions the children of a turn ask it, from its inbox, until it answers each. A child asks
 * one at a time, so it has at most one open. The inbox subscription is the wake the turn's waits
 * for its children wait on: a new question, or a child that finished; `refresh` reads what it has
 * not delivered yet, for an answer or the turn's end. Each question counts once, whatever the
 * broker delivers again.
 */
export class ChildQuestions {
  readonly #open = new Map<string, ChildQuestion>()
  readonly #seen = new Set<string>()
  /** Shared by every wait until the next question or finish settles it. */
  #wake: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined
  #cursor: string | undefined
  #listening: Promise<void> | undefined
  /** Whether the turn has a child: only then can it be asked. */
  #hasChildren = false
  #unsubscribe: (() => void) | undefined
  #closed = false

  constructor(
    private readonly mail: AgentRunMail,
    private readonly turnRunId: string
  ) {}

  /**
   * Start listening once the turn has a child: until then, nothing can ask it or finish. A
   * subscription that fails is tried again by the next call; until then, the turn reads its
   * questions only when it answers one, at its waits' re-checks and when it ends.
   */
  listen(): Promise<void> {
    this.#hasChildren = true
    this.#listening ??= this.mail
      .subscribe(
        { runId: this.turnRunId },
        { mail: (mail) => this.#receive(mail), childFinished: () => this.#changed() }
      )
      .then(
        (unsubscribe) => {
          if (this.#closed) unsubscribe()
          else this.#unsubscribe = unsubscribe
        },
        (error: unknown) => {
          this.#listening = undefined
          console.error(
            `[SixbAgentWorker] Agent run '${this.turnRunId}' could not listen for its children's questions; it tries again with its next child.`,
            error
          )
        }
      )
    return this.#listening
  }

  close(): void {
    this.#closed = true
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
  }

  /** Read the inbox up to now, once the turn has a child. */
  async refresh(): Promise<void> {
    if (!this.#hasChildren) return

    const page = await this.mail.read({ runId: this.turnRunId }, this.#cursor)
    this.#cursor = page.cursor ?? this.#cursor
    this.#receive(page.mail)
  }

  /** The questions no answer replied to yet, in the order they came. */
  open(): readonly ChildQuestion[] {
    return [...this.#open.values()]
  }

  /** The question `runId` waits on, if any. */
  of(runId: string): ChildQuestion | undefined {
    return this.#open.get(runId)
  }

  /** Whether the inbox subscription is up: else only `refresh` reads the questions. */
  get listening(): boolean {
    return this.#unsubscribe !== undefined
  }

  /** Open again a question an answer could not be sent to. */
  reopen(question: ChildQuestion): void {
    if (!this.#open.has(question.runId)) this.#open.set(question.runId, question)
  }

  answered(question: ChildQuestion): void {
    if (this.#open.get(question.runId)?.id === question.id) this.#open.delete(question.runId)
  }

  /**
   * Settles when a question comes or a child finishes. Take it before reading what it wakes for,
   * so what comes during the read wakes the wait.
   */
  nextChange(): Promise<void> {
    if (!this.#wake) {
      let resolve!: () => void
      const promise = new Promise<void>((settle) => {
        resolve = settle
      })
      this.#wake = { promise, resolve }
    }
    return this.#wake.promise
  }

  #receive(mail: readonly ReceivedAgentMail[]): void {
    let asked = false
    for (const question of mail) {
      if (question.kind !== "question" || this.#seen.has(question.id)) continue

      this.#seen.add(question.id)
      this.#open.set(question.fromRunId, {
        id: question.id,
        runId: question.fromRunId,
        text: question.text,
      })
      asked = true
    }
    if (asked) this.#changed()
  }

  #changed(): void {
    this.#wake?.resolve()
    this.#wake = undefined
  }
}

/**
 * What the Agent reads for its children's questions it has not seen yet, or, `earlier`, for the
 * children of earlier turns paused on theirs. The children's text is escaped: it must not close the
 * block or pass for one of Sixb's own.
 */
export function renderChildQuestions(
  questions: readonly (QuestionRef & { readonly key: string })[],
  options: { readonly earlier?: boolean } = {}
): string {
  const [tag, lead] = options.earlier
    ? [
        "sixb_waiting_children",
        "These sub-agents of earlier turns paused on a question. Once you have an answer, send it with message_agent and the key: the sub-agent continues where it stopped.",
      ]
    : [
        "sixb_child_questions",
        "Your sub-agents ask you, and wait for your answer. Answer each with message_agent and its key, or ask the user when only they can answer.",
      ]
  const lines = questions.map(
    (question) => `- ${escapeText(question.key)} asks: ${escapeText(question.text)}`
  )
  return [`<${tag}>`, lead, ...lines, `</${tag}>`].join("\n")
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
