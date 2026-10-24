import { heldCallsInOutput } from "./approvals"
import {
  classifyCommand,
  coerceBashInput,
  coerceBashOutput,
  describeBash,
  humanize,
} from "./bash/interpret"
import { type AgentMessages, en } from "./i18n/en"
import { childQuestions, describeMessageAgent } from "./message-agent/interpret"
import type { NormalizedPart, NormalizedTool } from "./parts"
import { isPublishTool, publishTitle } from "./publish-artifact/interpret"
import { coerceReadInput, coerceReadOutput, describeRead } from "./read/interpret"
import { webFetchUrl } from "./utils/web-fetch"
import { describeViewFile } from "./view-file/interpret"

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
    if (tool.state === "output-available" && heldCallsInOutput(tool.output).length > 0) {
      return messages.bash.heldForApproval
    }
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

  if (tool.toolName === "view_file") return messages.viewFile.running(describeViewFile(tool).target)
  if (tool.toolName === "message_agent") return describeMessageAgent(tool, messages).running
  const [question] = childQuestions(tool)
  if (question) return messages.activity.agentAsks(question.key, question.text)
  if (isPublishTool(tool.toolName)) {
    const title = publishTitle(tool)
    if (tool.state === "output-error") return messages.artifacts.publishFailed(title)
    if (tool.state === "output-available") return messages.artifacts.published(title)
    return messages.artifacts.publishing(title)
  }

  const name = humanize(tool.toolName)
  return name ? messages.activity.using(name) : messages.activity.working
}
