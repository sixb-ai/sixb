import { readFile } from "node:fs/promises"
import {
  asRecord,
  CliError,
  createInstanceApiClient,
  EXIT_API,
  fail,
  INSTANCE_CLI_VERSION,
  isFileError,
  isHelp,
  type SandboxInstanceCliMode,
  writeJson,
  writeText,
} from "@sixb/cli-core"
import { AGENT_RUNTIME_PROFILE, type AgentDoctorReport } from "../../agent-runtime/profile"

export async function doctor(args: readonly string[], mode: SandboxInstanceCliMode): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb doctor")
  if (args.length !== 0) fail("doctor accepts no arguments.")
  const project = asRecord(await createInstanceApiClient(mode).get("/api/project"))
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid project." },
      EXIT_API
    )
  }
  const report: AgentDoctorReport = {
    ok: true,
    profile: AGENT_RUNTIME_PROFILE,
    cli: { version: INSTANCE_CLI_VERSION },
    javascript: javascriptRuntime(),
    project: { id: project.id },
  }
  writeJson(report)
}

export async function context(args: readonly string[]): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb context")
  if (args.length !== 0) fail("context accepts no arguments.")
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

function javascriptRuntime(): AgentDoctorReport["javascript"] {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}
