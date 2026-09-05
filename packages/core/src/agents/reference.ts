import type { AgentReference } from "./types"

/** Project Agent capability used in security grants such as `can.run(agent)`. */
export const agent: AgentReference = Object.freeze({ kind: "agent" })
