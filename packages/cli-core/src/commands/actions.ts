import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, parseQueryOptions, readJson } from "./shared"

export async function actions(api: ApiClient, args: readonly string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || requestsHelp(rest)) return writeText(GROUP_HELP.actions)
  if (sub === "get") {
    const { positionals } = parseCommandArgs(rest, {}, "actions get", 1)
    return writeJson(await api.get(`/api/actions/${encodeURIComponent(positionals[0] ?? "")}`))
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
    const { positionals, options } = parseCommandArgs(
      rest,
      {
        "--subject-type": "string",
        "--subject-id": "string",
        "--file": "string",
        "--run-id": "string",
      },
      "actions request",
      1
    )
    const actionId = positionals[0] ?? ""
    const subjectType = options["--subject-type"]
    const subjectId = options["--subject-id"]
    const paramsSource = options["--file"]
    const runId = options["--run-id"]
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.")
    }
    const params = paramsSource ? await readJson(paramsSource) : {}
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.")
    }
    // The API answers once the Action has run, with its terminal run.
    return writeJson(
      await api.post(`/api/actions/${encodeURIComponent(actionId)}`, {
        params,
        ...(subjectType && subjectId
          ? { subject: { kind: "object", objectTypeId: subjectType, primaryId: subjectId } }
          : {}),
        ...(runId ? { runId } : {}),
      })
    )
  }
  fail(`Unknown actions command '${sub}'.`)
}
