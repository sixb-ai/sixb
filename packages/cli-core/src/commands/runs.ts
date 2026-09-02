import type { ApiClient } from "../api-client"
import { enumValue, isHelp, requireExact, requireOrderedRange, rfc3339Value } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS, DEFAULT_LIST_ORDER } from "../policies"
import { GROUP_HELP } from "./metadata"
import { normalizeWindowOptions, parseQueryOptions } from "./shared"

const ACTION_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const
const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const

export async function runs(
  api: ApiClient,
  kind: "action" | "workflow",
  args: readonly string[]
): Promise<void> {
  const [sub, ...rest] = args
  const group = `${kind}-runs` as "action-runs" | "workflow-runs"
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP[group])
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
    const options = normalizeWindowOptions(
      parseQueryOptions(rest, kind === "action" ? action : workflow, `${group} list`),
      {
        defaultLimit: CLI_LIMITS.list.default,
        maximumLimit: CLI_LIMITS.list.maximum,
        defaultOrder: DEFAULT_LIST_ORDER,
        offset: true,
      }
    )
    if (options.status !== undefined) {
      options.status = enumValue(
        "--status",
        options.status,
        kind === "action" ? ACTION_RUN_STATUSES : WORKFLOW_RUN_STATUSES
      )
    }
    for (const [name, flag] of [
      ["startedAfter", "--started-after"],
      ["startedBefore", "--started-before"],
    ] as const) {
      if (options[name] !== undefined) options[name] = rfc3339Value(flag, options[name])
    }
    requireOrderedRange(
      "--started-after",
      options.startedAfter,
      "--started-before",
      options.startedBefore
    )
    return writeJson(await api.get(`/api/${group}`, options))
  }
  fail(`Unknown ${group} command '${sub}'.`)
}
