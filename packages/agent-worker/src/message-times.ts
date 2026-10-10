import type { AgentMessageRecord, AgentStorage } from "@sixb/core/storage"
import { renderCurrentTime } from "./agent-prompt"

/**
 * The `<sixb_current_time>` closing each retained user message: when it was sent, in the time zone
 * of the run that answered it (the project's when that run captured none). Stored data only, so
 * every later run replays the same bytes and the history stays a cacheable prefix.
 */
export async function loadUserMessageTimes(input: {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly threadId: string
  readonly messages: readonly AgentMessageRecord[]
  readonly projectTimeZone: string
}): Promise<ReadonlyMap<string, string>> {
  const userMessages = input.messages.filter((message) => message.role === "user")
  const oldest = userMessages[0]
  if (!oldest) return new Map()

  // A run starts after its trigger message, so this window holds every run that answered one.
  const { runs } = await input.storage.runs.list({
    projectId: input.projectId,
    threadId: input.threadId,
    kinds: ["conversation"],
    startedAfter: new Date(oldest.createdAt.getTime() - 1),
  })
  const timeZoneByTrigger = new Map<string, string>()
  for (const run of runs) {
    if (run.kind === "conversation" && run.spec?.timeZone) {
      timeZoneByTrigger.set(run.triggerMessageId, run.spec.timeZone)
    }
  }
  return new Map(
    userMessages.map((message) => [
      message.id,
      renderCurrentTime(
        message.createdAt,
        timeZoneByTrigger.get(message.id) ?? input.projectTimeZone
      ),
    ])
  )
}
