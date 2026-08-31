/** Prompt appended to the final reserved model step after local tools are disabled. */
export const FINAL_AGENT_LOOP_STEP_INSTRUCTION = [
  "Provide the best possible final answer from the context available.",
  "This is the final step, so do not call tools or defer the answer.",
  "If the task cannot be completed from the available context, state the limitation clearly instead of inventing information.",
].join(" ")
