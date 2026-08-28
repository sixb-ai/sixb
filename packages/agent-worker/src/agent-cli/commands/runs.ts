import { ApiClient } from "../api-client"
import { isHelp, requireExact } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { parseQueryOptions } from "./shared"

export async function runs(kind: "action" | "workflow", args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const group = `${kind}-runs` as "action-runs" | "workflow-runs"
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP[group])
  const api = new ApiClient()
  if (sub === "get") {
    requireExact(rest, 1, `${group} get requires exactly one run id.`)
    return writeJson(await api.get(`/api/${group}/${encodeURIComponent(rest[0] ?? "")}`))
  }
  if (sub === "list") {
    const common = {
      "--status": "status",
      "--started-after": "startedAfter",
      "--started-before": "startedBefore",
      "--limit": "limit",
      "--offset": "offset",
      "--order": "order",
    }
    const action = {
      ...common,
      "--action": "actionId",
      "--type": "objectTypeId",
      "--id": "primaryId",
    }
    const workflow = { ...common, "--workflow": "workflowId" }
    return writeJson(
      await api.get(
        `/api/${group}`,
        parseQueryOptions(rest, kind === "action" ? action : workflow, `${group} list`)
      )
    )
  }
  fail(`Unknown ${group} command '${sub}'.`)
}
