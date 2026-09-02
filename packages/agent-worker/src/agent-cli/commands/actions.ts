import { ApiClient } from "../api-client"
import { isHelp, requireExact, requireValue } from "../arguments"
import { CliError, EXIT_API, fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, parseQueryOptions, readJson } from "./shared"

export async function actions(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || args.some(isHelp)) return writeText(GROUP_HELP.actions)
  const api = new ApiClient()
  if (sub === "get") {
    requireExact(rest, 1, "actions get requires exactly one action id.")
    return writeJson(await api.get(`/api/actions/${encodeURIComponent(rest[0] ?? "")}`))
  }
  if (sub === "list") {
    const options = parseQueryOptions(rest, { "--type": "objectTypeId" }, "actions list")
    const response = await api.get("/api/actions")
    if (!options.objectTypeId) return writeJson(response)
    if (!Array.isArray(response)) fail("The actions API returned an invalid response.")
    return writeJson(
      response.filter((value) => asRecord(value).objectTypeId === options.objectTypeId)
    )
  }
  if (sub === "request") {
    const actionId = requireValue("actions request", rest[0])
    let subjectType: string | undefined
    let subjectId: string | undefined
    let paramsSource: string | undefined
    let runId: string | undefined
    let wait = false
    for (let index = 1; index < rest.length; index += 1) {
      const flag = rest[index]
      if (flag === "--subject-type") subjectType = requireValue(flag, rest[++index])
      else if (flag === "--subject-id") subjectId = requireValue(flag, rest[++index])
      else if (flag === "--file") paramsSource = requireValue(flag, rest[++index])
      else if (flag === "--run-id") runId = requireValue(flag, rest[++index])
      else if (flag === "--wait") {
        if (wait) fail("--wait may be provided only once.")
        wait = true
      } else fail(`Unknown actions request option '${flag}'.`)
    }
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.")
    }
    const params = paramsSource ? await readJson(paramsSource) : {}
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.")
    }
    const requested = await api.post(`/api/actions/${encodeURIComponent(actionId)}`, {
      params,
      ...(subjectType && subjectId
        ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } }
        : {}),
      ...(runId ? { runId } : {}),
    })
    if (!wait) return writeJson(requested)

    const requestedRunId = asRecord(requested).runId
    if (typeof requestedRunId !== "string" || requestedRunId.length === 0) {
      throw new CliError(
        {
          code: "invalid_api_response",
          message: "The Action request response did not contain a run id.",
        },
        EXIT_API
      )
    }
    return writeJson(await waitForActionRun(api, requestedRunId))
  }
  fail(`Unknown actions command '${sub}'.`)
}

const ACTION_WAIT_TIMEOUT_MS = 25_000
const ACTION_WAIT_POLL_MS = 250
const TERMINAL_ACTION_STATUSES = new Set(["succeeded", "failed", "cancelled"])

async function waitForActionRun(api: ApiClient, runId: string): Promise<unknown> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < ACTION_WAIT_TIMEOUT_MS) {
    const run = await api.get(`/api/action-runs/${encodeURIComponent(runId)}`)
    const status = asRecord(run).status
    if (typeof status === "string" && TERMINAL_ACTION_STATUSES.has(status)) return run
    await new Promise((resolve) => setTimeout(resolve, ACTION_WAIT_POLL_MS))
  }

  throw new CliError(
    {
      code: "action_wait_timeout",
      message: `Action run '${runId}' did not finish within ${ACTION_WAIT_TIMEOUT_MS / 1_000} seconds.`,
      hint: `Inspect it with 'sixb action-runs get ${runId}'.`,
    },
    EXIT_API
  )
}
