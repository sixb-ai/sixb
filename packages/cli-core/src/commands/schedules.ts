import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { idSegment } from "./shared"

export async function schedules(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.schedules)

  if (sub === "run") {
    const {
      positionals: [scheduleId],
    } = parseCommandArgs(rest, {}, "schedules run", 1)
    return writeJson(await api.post(`/api/schedules/${idSegment(scheduleId)}/runs`, {}))
  }

  fail(`Unknown schedules command '${sub}'.`)
}
