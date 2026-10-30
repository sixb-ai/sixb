import type { ApiClient } from "../api-client"
import {
  enumValue,
  isHelp,
  parseCommandArgs,
  requestsHelp,
  requireOrderedRange,
  rfc3339Value,
} from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { CLI_LIMITS, DEFAULT_LIST_ORDER } from "../policies"
import { GROUP_HELP } from "./metadata"
import { normalizeWindowOptions, parseQueryOptions } from "./shared"

const ACTION_RUN_STATUSES = ["succeeded", "failed"] as const
const WORKFLOW_RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
] as const
const DATA_RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const

const STATUSES = {
  action: ACTION_RUN_STATUSES,
  workflow: WORKFLOW_RUN_STATUSES,
  sync: DATA_RUN_STATUSES,
  pipeline: DATA_RUN_STATUSES,
} as const

/** The list filters each kind adds to the common window, by flag and query parameter. */
const FILTERS = {
  action: { "--action": "actionId", "--type": "objectTypeId", "--id": "primaryId" },
  workflow: { "--workflow": "workflowId" },
  sync: { "--sync": "syncId", "--dataset": "datasetId" },
  pipeline: { "--pipeline": "pipelineId" },
} as const

export async function runs(
  api: ApiClient,
  kind: keyof typeof STATUSES,
  args: readonly string[]
): Promise<void> {
  const [sub, ...rest] = args
  const group = `${kind}-runs` as const
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP[group])
  // The API lists sync runs but has no route for one.
  if (sub === "get" && kind !== "sync") {
    const { positionals } = parseCommandArgs(rest, {}, `${group} get`, 1)
    return writeJson(await api.get(`/api/${group}/${encodeURIComponent(positionals[0] ?? "")}`))
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
    const options = normalizeWindowOptions(
      parseQueryOptions(rest, { ...common, ...FILTERS[kind] }, `${group} list`),
      {
        defaultLimit: CLI_LIMITS.list.default,
        maximumLimit: CLI_LIMITS.list.maximum,
        defaultOrder: DEFAULT_LIST_ORDER,
        offset: true,
      }
    )
    if (options.status !== undefined) {
      options.status = enumValue("--status", options.status, STATUSES[kind])
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
