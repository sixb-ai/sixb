import { waitForAbort } from "./abort"
import type { ChildQuestion, QuestionRef } from "./child-questions"

// A turn and the children it runs share a runner, wherever it runs: the worker, or a computer. So
// what they say to each other never leaves it. A child's answer and its files reach the turn
// through the child's run; what it never read when it paused, through its run's result.

/** What a turn sends one of its children: a message, or a reply to its question. */
export interface ChildMail {
  /** Names the turn's tool call, so a replay of the call sends nothing twice. */
  readonly id: string
  readonly kind: "message" | "answer" | "deferred"
  readonly text: string
  /** The question a reply answers. */
  readonly inReplyTo?: string
}

/** A message a child had not read when it stopped. */
export type UnreadChildMail = Pick<ChildMail, "id" | "text">

/** The child stopped reading: it paused or ended, so mail sent to it now would never be read. */
export class ChildMailClosedError extends Error {
  readonly name = "ChildMailClosedError"
  constructor(readonly childRunId: string) {
    super(`[SixbAgent] Subagent run '${childRunId}' reads no more mail.`)
  }
}

/** One child's side of its turn's mailbox. */
export interface ChildMailbox {
  /** The messages sent since the last take, in the order they were sent. */
  take(): readonly UnreadChildMail[]
  /** Ask the turn, and wait for its reply: an answer, or `deferred` when the turn ends first. */
  ask(question: QuestionRef, signal: AbortSignal): Promise<ChildMail>
  /** Stop reading: what came and was never taken is returned, and later mail is refused. */
  close(): readonly UnreadChildMail[]
}

/**
 * The mail between a turn and the children it runs, held in their runner, one per turn. The turn
 * sends its children messages and replies, and hears their questions and their ends; each child
 * takes its messages at its step boundaries and asks its questions.
 */
export class FamilyMailbox {
  readonly #children = new Map<string, ChildBox>()
  /** The questions no reply settled yet, by the child that asked: one at a time each. */
  readonly #questions = new Map<string, ChildQuestion>()
  #wake: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined
  #closed = false

  /**
   * Send a child mail. Sent twice under one id, it arrives once. Throws
   * {@link ChildMailClosedError} once the child stopped reading, or the turn ended.
   */
  send(childRunId: string, mail: ChildMail): void {
    if (this.#closed) throw new ChildMailClosedError(childRunId)
    this.#box(childRunId).deliver(mail)
  }

  /** The child's side, for its runner: mail sent before it started is there already. */
  child(childRunId: string): ChildMailbox {
    return this.#box(childRunId)
  }

  /** The questions the turn's children wait on, in the order they asked. */
  questions(): readonly ChildQuestion[] {
    return [...this.#questions.values()]
  }

  /** The question `childRunId` waits on, if any. */
  question(childRunId: string): ChildQuestion | undefined {
    return this.#questions.get(childRunId)
  }

  /** The turn took the question to answer it: no other answer is sent to it. */
  answered(question: ChildQuestion): void {
    if (this.#questions.get(question.runId)?.id === question.id) {
      this.#questions.delete(question.runId)
    }
  }

  /** Open again a question its answer could not be sent to. */
  reopen(question: ChildQuestion): void {
    if (!this.#questions.has(question.runId)) this.#questions.set(question.runId, question)
  }

  /** A child's run ended, or paused: its runner says so, and the turn's waits wake. */
  finished(childRunId: string): void {
    this.#children.get(childRunId)?.close()
    this.#questions.delete(childRunId)
    this.#changed()
  }

  /**
   * Settles when a child asks or finishes. Take it before reading what it wakes for, so what
   * comes during the read wakes the wait.
   */
  changed(): Promise<void> {
    if (!this.#wake) {
      let resolve!: () => void
      const promise = new Promise<void>((settle) => {
        resolve = settle
      })
      this.#wake = { promise, resolve }
    }
    return this.#wake.promise
  }

  /** The turn ended: it sends nothing more. */
  close(): void {
    this.#closed = true
  }

  #box(childRunId: string): ChildBox {
    let box = this.#children.get(childRunId)
    if (!box) {
      box = new ChildBox(childRunId, {
        asked: (question) => {
          this.#questions.set(childRunId, { ...question, runId: childRunId })
          this.#changed()
        },
        withdrawn: (question) => {
          if (this.#questions.get(childRunId)?.id === question.id) {
            this.#questions.delete(childRunId)
          }
        },
      })
      this.#children.set(childRunId, box)
    }
    return box
  }

  #changed(): void {
    this.#wake?.resolve()
    this.#wake = undefined
  }
}

class ChildBox implements ChildMailbox {
  readonly #seen = new Set<string>()
  #unread: UnreadChildMail[] = []
  #asking: { readonly id: string; readonly reply: (mail: ChildMail) => void } | undefined
  #closed = false

  constructor(
    private readonly runId: string,
    private readonly family: {
      readonly asked: (question: QuestionRef) => void
      readonly withdrawn: (question: QuestionRef) => void
    }
  ) {}

  deliver(mail: ChildMail): void {
    if (this.#closed) throw new ChildMailClosedError(this.runId)
    if (this.#seen.has(mail.id)) return
    this.#seen.add(mail.id)

    if (mail.kind === "message") {
      this.#unread.push({ id: mail.id, text: mail.text })
    } else if (this.#asking && mail.inReplyTo === this.#asking.id) {
      this.#asking.reply(mail)
    }
    // A reply to a question the child no longer asks has no one to read it.
  }

  take(): readonly UnreadChildMail[] {
    const taken = this.#unread
    this.#unread = []
    return taken
  }

  async ask(question: QuestionRef, signal: AbortSignal): Promise<ChildMail> {
    signal.throwIfAborted()
    const reply = Promise.withResolvers<ChildMail>()
    this.#asking = { id: question.id, reply: reply.resolve }
    this.family.asked(question)
    try {
      return await waitForAbort(reply.promise, signal)
    } finally {
      this.#asking = undefined
      this.family.withdrawn(question)
    }
  }

  close(): readonly UnreadChildMail[] {
    this.#closed = true
    return this.take()
  }
}
