import { ApiClient } from "../api-client"
import { isHelp, requireExact, requireValue } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, parseQueryOptions, readJson } from "./shared"

export async function actions(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (!sub || isHelp(sub) || isHelp(rest[0])) return writeText(GROUP_HELP.actions)
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
    for (let index = 1; index < rest.length; index += 1) {
      const flag = rest[index]
      if (flag === "--subject-type") subjectType = requireValue(flag, rest[++index])
      else if (flag === "--subject-id") subjectId = requireValue(flag, rest[++index])
      else if (flag === "--file") paramsSource = requireValue(flag, rest[++index])
      else if (flag === "--run-id") runId = requireValue(flag, rest[++index])
      else fail(`Unknown actions request option '${flag}'.`)
    }
    if (Boolean(subjectType) !== Boolean(subjectId)) {
      fail("--subject-type and --subject-id must be provided together.")
    }
    const params = paramsSource ? await readJson(paramsSource) : {}
    if (Array.isArray(params) || typeof params !== "object" || params === null) {
      fail("Action params must be a JSON object.")
    }
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
