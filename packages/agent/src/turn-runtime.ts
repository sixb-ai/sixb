import { throwIfExecutionLost } from "./errors"

export interface AgentTurnRuntime {
  /** Worker shutdown, queue-lease loss, and user cancellation. */
  readonly sourceSignal: AbortSignal
  /** The run's signal: `sourceSignal`, and the run's end. */
  readonly signal: AbortSignal
  /** Surface lost ownership or cancellation before another durable action. */
  readonly assertCanContinue: () => void
  /** End the run: aborts `signal`, so a tool call that outlived it stops calling models. */
  dispose(): void
}

/**
 * The run's signal, shared by its compaction and its answer. A run has no time or step limit: it
 * ends when the model answers, when it is cancelled, or when its runner loses it. Its model records
 * each call itself, so a call that could not be admitted or recorded fails where it was made.
 */
export function createAgentTurnRuntime(input: { readonly signal: AbortSignal }): AgentTurnRuntime {
  const ended = new AbortController()

  return {
    sourceSignal: input.signal,
    signal: AbortSignal.any([input.signal, ended.signal]),
    assertCanContinue() {
      throwIfExecutionLost(input.signal)
      input.signal.throwIfAborted()
    },
    dispose() {
      ended.abort(new DOMException("The Agent run has ended.", "AbortError"))
    },
  }
}
