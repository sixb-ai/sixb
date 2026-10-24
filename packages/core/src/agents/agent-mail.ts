import type { AgentMailPart } from "./message"

/**
 * What the model reads for an {@link AgentMailPart}. The live delivery and a later run's replay of
 * the child's thread both project it here, so a continuation's prefix keeps its bytes.
 */
export function agentMailInstruction(part: AgentMailPart): string {
  return `<sixb_parent_message id="${part.id}">${part.text}</sixb_parent_message>`
}
