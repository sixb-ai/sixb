import type { AgentMailPart } from "./message"

/** Read after a message that came as the reader answered: what it wrote is not delivered. */
const AFTER_ANSWER =
  "Your parent sent this after your answer above, which it has not received. Write your complete result again, accounting for this message: only what you write now reaches it."

/**
 * What the model reads for an {@link AgentMailPart}. The live delivery and a later run's replay of
 * the child's thread both project it here, so a continuation's prefix keeps its bytes. The
 * sender's text is escaped: it may quote what a tool read, and must not close the block or pass
 * for one of Sixb's own.
 */
export function agentMailInstruction(part: AgentMailPart): string {
  const block = `<sixb_parent_message id="${escapeAttribute(part.id)}">${escapeText(part.text)}</sixb_parent_message>`
  return part.afterAnswer ? `${block}\n\n${AFTER_ANSWER}` : block
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;")
}
