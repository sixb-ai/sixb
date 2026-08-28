import { readFile } from "node:fs/promises"
import { ApiClient } from "../api-client"
import { isHelp, requireExact } from "../arguments"
import { AGENT_CLI_VERSION, fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { isFileError } from "./shared"

export async function doctor(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.doctor)
  requireExact(args, 0, "doctor accepts no arguments.")
  const api = new ApiClient()
  writeJson({
    ok: true,
    cliVersion: AGENT_CLI_VERSION,
    runtime: runtimeInfo(),
    project: await api.get("/api/project"),
  })
}

export async function context(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.context)
  requireExact(args, 0, "context accepts no arguments.")
  const path = process.env.SIXB_RUN_CONTEXT
  if (!path) fail("SIXB_RUN_CONTEXT is not set.")
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (isFileError(error, "ENOENT")) fail(`Run context '${path}' does not exist.`)
    throw error
  }
  try {
    writeJson(JSON.parse(text))
  } catch {
    fail(`Run context '${path}' is not valid JSON.`, "invalid_json")
  }
}

export async function project(args: string[]): Promise<void> {
  if (!args[0] || isHelp(args[0])) return writeText(GROUP_HELP.project)
  if (args[0] !== "show") fail(`Unknown project command '${args[0]}'.`)
  requireExact(args, 1, "project show accepts no arguments.")
  writeJson(await new ApiClient().get("/api/project"))
}

function runtimeInfo(): { readonly name: "bun" | "node"; readonly version: string } {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}
