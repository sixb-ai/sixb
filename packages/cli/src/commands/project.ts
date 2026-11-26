import type { ApiClient } from "../api-client"
import { isHelp, parseCommandArgs, requestsHelp } from "../arguments"
import { fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"

export async function project(api: ApiClient, args: readonly string[]): Promise<void> {
  if (!args[0] || isHelp(args[0]) || (args[0] === "show" && requestsHelp(args.slice(1)))) {
    return writeText(GROUP_HELP.project)
  }
  if (args[0] !== "show") fail(`Unknown project command '${args[0]}'.`)
  parseCommandArgs(args.slice(1), {}, "project show")
  writeJson(await api.get("/api/project"))
}
