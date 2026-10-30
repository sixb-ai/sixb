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
