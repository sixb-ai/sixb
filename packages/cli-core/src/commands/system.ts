import { readFile } from "node:fs/promises"
import { isHelp } from "../arguments"
import { CliError, EXIT_API, fail, INSTANCE_CLI_VERSION, writeJson, writeText } from "../output"
import { createInstanceApiClient, type SandboxInstanceCliMode } from "../run"
import { asRecord, isFileError } from "./shared"

/** The sandbox runtime `sixb status` reports and the agent worker's preflight expects. */
export const AGENT_RUNTIME_PROFILE = "sixb-agent-runtime/v1" as const

/** Stable JSON emitted by `sixb status` in a sandbox and consumed by worker preflight. */
export interface SandboxStatusReport {
  readonly ok: true
  readonly profile: typeof AGENT_RUNTIME_PROFILE
  readonly cli: { readonly version: string }
  readonly javascript: {
    readonly name: "bun" | "node"
    readonly version: string
  }
  readonly project: { readonly id: string }
}

export async function status(args: readonly string[], mode: SandboxInstanceCliMode): Promise<void> {
  if (isHelp(args[0])) return writeText("Usage: sixb status")
  if (args.length !== 0) fail("status accepts no arguments.")
  const project = asRecord(await createInstanceApiClient(mode).get("/api/project"))
  if (typeof project.id !== "string" || project.id.length === 0) {
    throw new CliError(
      { code: "invalid_api_response", message: "The Sixb API returned an invalid project." },
      EXIT_API
    )
  }
  const report: SandboxStatusReport = {
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

function javascriptRuntime(): SandboxStatusReport["javascript"] {
  if (typeof globalThis.Bun === "object") {
    return { name: "bun", version: globalThis.Bun.version }
  }
  return { name: "node", version: process.versions.node }
}
