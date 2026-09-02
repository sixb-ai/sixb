import type { ApiClient } from "../api-client"
import { isHelp, requireExact, requireValue } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { readJson, singleFileOption } from "./shared"

export async function workflows(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.workflows)
  if (sub === "list") {
    requireExact(rest, 0, "workflows list accepts no arguments.")
    return writeJson(await api.get("/api/workflows"))
  }
  const workflowId = rest[0]
  if (sub === "get") {
    requireExact(rest, 1, "workflows get requires exactly one workflow id.")
    return writeJson(await api.get(`/api/workflows/${encodeURIComponent(workflowId ?? "")}`))
  }
  if (sub === "start") {
    requireValue("workflows start", workflowId)
    let input: unknown = {}
    if (rest.length > 1) {
      input = await readJson(singleFileOption(rest.slice(1), "workflows start"))
    }
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.")
    }
    return writeJson(
      await api.post(`/api/workflows/${encodeURIComponent(workflowId ?? "")}/runs`, { input })
    )
  }
  fail(`Unknown workflows command '${sub}'.`)
}
