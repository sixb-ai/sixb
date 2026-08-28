import { ApiClient } from "../api-client"
import { isHelp, requireExact } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { parseQueryOptions, readJson, singleFileOption } from "./shared"

export async function telemetry(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.telemetry)
  const api = new ApiClient()
  if (sub === "latest") {
    requireExact(rest, 3, "telemetry latest requires object type, primary id, and property id.")
    return writeJson(await api.get(telemetryPath(rest, "latest")))
  }
  if (sub === "history") {
    if (rest.length < 3)
      fail("telemetry history requires object type, primary id, and property id.")
    const query = parseQueryOptions(
      rest.slice(3),
      { "--from": "from", "--to": "to", "--limit": "limit", "--order": "order" },
      "telemetry history"
    )
    return writeJson(await api.get(telemetryPath(rest, "history"), query))
  }
  if (sub === "query") {
    return writeJson(
      await api.post(
        "/api/telemetry/history",
        await readJson(singleFileOption(rest, "telemetry query"))
      )
    )
  }
  fail(`Unknown telemetry command '${sub}'.`)
}

function telemetryPath(args: readonly string[], terminal: "latest" | "history"): string {
  return `/api/objects/${encodeURIComponent(args[0] ?? "")}/${encodeURIComponent(args[1] ?? "")}/telemetry/${encodeURIComponent(args[2] ?? "")}/${terminal}`
}
