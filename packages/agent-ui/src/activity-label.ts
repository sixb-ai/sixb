import {
  classifyCommand,
  coerceBashInput,
  coerceBashOutput,
  describeBash,
  humanize,
} from "./bash/interpret"
import { type AgentMessages, en } from "./i18n/en"
import type { NormalizedPart, NormalizedTool } from "./parts"
import { coerceReadInput, coerceReadOutput, describeRead } from "./read/interpret"
import { webFetchUrl } from "./utils/webFetch"

/** A short, present-tense label for the newest visible step in a live work group. */
export function latestWorkLabel(
  parts: readonly NormalizedPart[],
  messages: AgentMessages = en
): string {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.kind === "tool") return toolProgressLabel(part.tool, messages)
    // `reasoning-start` has no text. Keep the pre-token "Thinking" label through that lifecycle
    // chunk so the first reasoning delta does not look like a new row mounting.
    if (part?.kind === "reasoning") return messages.activity.thinking
  }
  return messages.activity.working
}

function toolProgressLabel(tool: NormalizedTool, messages: AgentMessages): string {
  if (tool.toolName === "web_fetch") {
    const domain = webFetchUrl(tool.input)?.hostname.replace(/^www\./, "") ?? messages.web.webPage
    if (tool.state === "output-error") return messages.web.readFailed(domain)
    if (tool.state === "output-available") return messages.web.reviewing(domain)
    return messages.web.reading(domain)
  }
  if (tool.toolName === "web_search") {
    if (tool.state === "output-error") return messages.web.continuingAfterFailure
    if (tool.state === "output-available") return messages.web.reviewingResults
    return messages.web.searching
  }
  if (tool.toolName === "bash") {
    if (tool.state === "input-streaming") return messages.bash.preparing
    const input = coerceBashInput(tool.input)
    const command = input?.command ?? tool.inputText ?? ""
    const intent = classifyCommand(command)
    const description = describeBash(intent, coerceBashOutput(tool.output), messages)
    return description.runningTitle
  }

  if (tool.toolName === "read") {
    const description = describeRead(
      coerceReadInput(tool.input),
      coerceReadOutput(tool.output),
      messages
    )
    return description.runningTitle
  }

  const name = humanize(tool.toolName)
  return name ? messages.activity.using(name) : messages.activity.working
}
