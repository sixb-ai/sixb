import { readFile } from "node:fs/promises"
import { AGENT_RUNTIME_PROFILE, type AgentDoctorReport } from "../../agent-runtime/profile"
import { ApiClient } from "../api-client"
import { isHelp, requireExact } from "../arguments"
import { AGENT_CLI_VERSION, CliError, EXIT_API, fail, writeJson, writeText } from "../output"
import { GROUP_HELP } from "./metadata"
import { asRecord, isFileError } from "./shared"

export async function doctor(args: string[]): Promise<void> {
  if (isHelp(args[0])) return writeText(GROUP_HELP.doctor)
  requireExact(args, 0, "doctor accepts no arguments.")
  const project = asRecord(await new ApiClient().get("/api/project"))
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid project." },
      EXIT_API
    )
  }
  const report: AgentDoctorReport = {
    ok: true,
    profile: AGENT_RUNTIME_PROFILE,
    cli: { version: AGENT_CLI_VERSION },
    javascript: javascriptRuntime(),
    project: { id: project.id },
  }
  writeJson(report)
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
  if (!args[0] || isHelp(args[0]) || (args[0] === "show" && isHelp(args[1]))) {
    return writeText(GROUP_HELP.project)
  }
  if (args[0] !== "show") fail(`Unknown project command '${args[0]}'.`)
  requireExact(args, 1, "project show accepts no arguments.")
  writeJson(await new ApiClient().get("/api/project"))
}

function javascriptRuntime(): AgentDoctorReport["javascript"] {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}
