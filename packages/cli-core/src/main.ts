#!/usr/bin/env node

// The `sixb` a sandbox runs: the API commands people run, plus the run's own (`status`,
// `context`, `memory`). `bun run generate:sandbox-cli` bundles it into generated/sixb.mjs.
import { isHelp } from "./arguments"
import { isInstanceCommand } from "./commands"
import { memory } from "./commands/memory"
import { renderInstanceHelp } from "./commands/metadata"
import { context, status } from "./commands/system"
import { fail, INSTANCE_CLI_VERSION, reportError, writeText } from "./output"
import { runInstanceCli } from "./run"

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (!command || isHelp(command)) return writeText(renderInstanceHelp("sandbox"))
  if (command === "--version" || command === "version") {
    return writeText(`sixb CLI ${INSTANCE_CLI_VERSION}`)
  }
  if (command === "status") return status(rest, sandboxMode())
  if (command === "context") return context(rest)
  if (command === "memory") return memory(rest, sandboxMode())
  if (!isInstanceCommand(command)) fail(`Unknown command '${command}'. Run 'sixb --help'.`)

  await runInstanceCli({ args, mode: sandboxMode() })
}

function sandboxMode() {
  return {
    kind: "sandbox" as const,
    baseUrl: process.env.SIXB_API_BASE_URL ?? "",
    runContextPath: process.env.SIXB_RUN_CONTEXT ?? "",
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.exitCode = reportError(error)
}
