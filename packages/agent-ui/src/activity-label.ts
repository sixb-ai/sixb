import {
  classifyCommand,
  coerceBashInput,
  coerceBashOutput,
  describeBash,
  humanize,
} from "./bash/interpret"
import type { NormalizedPart, NormalizedTool } from "./parts"
import { coerceReadInput, coerceReadOutput, describeRead } from "./read/interpret"

/** A short, present-tense label for the newest visible step in a live work group. */
export function latestWorkLabel(parts: readonly NormalizedPart[]): string {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.kind === "tool") return toolProgressLabel(part.tool)
    if (part?.kind === "reasoning" && part.text.trim()) return "Thinking"
  }
  return "Working"
}

function toolProgressLabel(tool: NormalizedTool): string {
  if (tool.toolName === "bash") {
    if (tool.state === "input-streaming") return "Preparing a command"
    const input = coerceBashInput(tool.input)
    const command = input?.command ?? tool.inputText ?? ""
    const intent = classifyCommand(command)
    const description = describeBash(intent, coerceBashOutput(tool.output))
    return description.runningTitle
  }

  if (tool.toolName === "read") {
    const description = describeRead(coerceReadInput(tool.input), coerceReadOutput(tool.output))
    return `Reading ${description.target}`
  }

  const name = humanize(tool.toolName)
  return name ? `Using ${name}` : "Working"
}
