import { randomUUID } from "node:crypto"
import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeRequestResult, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { idSegment, readJson } from "./shared"

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
    return writeJson(await api.get(`/api/workflows/${idSegment(workflowId)}`))
  }
  if (sub === "start") {
    const {
      positionals: [workflowId],
      options,
    } = parseCommandArgs(rest, { "--file": "string", "--run-id": "string" }, "workflows start", 1)
    const input: unknown = options["--file"] ? await readJson(options["--file"]) : {}
    if (Array.isArray(input) || typeof input !== "object" || input === null) {
      fail("Workflow input must be a JSON object.")
    }
    // Every start names its run, so a repeated request returns the same run instead of another.
    const runId = options["--run-id"] ?? `run_${randomUUID()}`
    return writeRequestResult(
      await api.post(`/api/workflows/${idSegment(workflowId)}/runs`, {
        input,
        runId,
      })
    )
  }
  fail(`Unknown workflows command '${sub}'.`)
}
