import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { readJson } from "./shared"

export async function workflows(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.workflows)
  if (sub === "list") {
    parseCommandArgs(rest, {}, "workflows list")
    return writeJson(await api.get("/api/workflows"))
  }
  if (sub === "get") {
    const {
      positionals: [workflowId],
    } = parseCommandArgs(rest, {}, "workflows get", 1)
    return writeJson(await api.get(`/api/workflows/${encodeURIComponent(workflowId ?? "")}`))
  }
  if (sub === "start") {
    const {
      positionals: [workflowId],
      options,
    } = parseCommandArgs(rest, { "--file": "string" }, "workflows start", 1)
    const input: unknown = options["--file"] ? await readJson(options["--file"]) : {}
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.")
    }
    return writeJson(
      await api.post(`/api/workflows/${encodeURIComponent(workflowId ?? "")}/runs`, { input })
    )
  }
  fail(`Unknown workflows command '${sub}'.`)
}
