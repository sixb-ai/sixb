import type { NormalizedTool } from "./parts"

// `wait` and `stop` name background commands, by the `bg_` id `bash` returned, and sub-agents, by
// their key. Earlier threads hold the tools before them: `bash_output` and `bash_stop` for a
// command, `wait_agent` for sub-agents, by run id.

/** The tools that read or stop a background command, today's and earlier threads'. */
export const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  "wait",
  "stop",
  "bash_output",
  "bash_stop",
])

/** What a `wait` or a `stop` names: the ids it was called with, as the model wrote them. */
export function namedIds(tool: Pick<NormalizedTool, "toolName" | "input">): readonly string[] {
  const input = isRecord(tool.input) ? tool.input : {}
  const ids = Array.isArray(input.ids)
    ? input.ids
    : Array.isArray(input.runIds)
      ? input.runIds
      : [input.id]
  return ids.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim()] : []))
}

/** Whether an id names a background command rather than a sub-agent. */
export function isCommandId(id: string): boolean {
  return id.startsWith("bg_")
}

/** Whether a call waits for, or stops, one of the Agent's sub-agents: its row stands for it. */
export function waitsForChildren(tool: Pick<NormalizedTool, "toolName" | "input">): boolean {
  if (tool.toolName === "wait_agent") return true
  if (tool.toolName !== "wait" && tool.toolName !== "stop") return false
  return namedIds(tool).some((id) => !isCommandId(id))
}

/** Whether a call reads, waits for, or stops background commands alone. */
export function waitsForCommandsOnly(tool: Pick<NormalizedTool, "toolName" | "input">): boolean {
  return COMMAND_TOOLS.has(tool.toolName) && !waitsForChildren(tool)
}

/** Whether a call stops what it names. */
export function isStop(tool: Pick<NormalizedTool, "toolName">): boolean {
  return tool.toolName === "stop" || tool.toolName === "bash_stop"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
