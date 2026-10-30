import type { AgentTurnHistory } from "@sixb/core/internal/agents"
import { renderCurrentTime } from "./agent-prompt"

/**
 * The `<sixb_current_time>` closing each retained user message: when it was sent, in the time zone
 * of the run that answered it (the project's when that run captured none). Stored data only, so
 * every later run replays the same bytes and the history stays a cacheable prefix.
 */
export function userMessageTimes(
  history: AgentTurnHistory,
  projectTimeZone: string
): ReadonlyMap<string, string> {
  return new Map(
    history.messages
      .filter((message) => message.role === "user")
      .map((message) => [
        message.id,
        renderCurrentTime(message.createdAt, history.sentTimeZones[message.id] ?? projectTimeZone),
      ])
  )
}
