#!/usr/bin/env node

// Standalone API CLI bundle. `bun run generate:sandbox-cli` bundles it into generated/sixb.mjs.
import { isHelp } from "./arguments"
import { isInstanceCommand } from "./commands"
import { history } from "./commands/history"
import { memory } from "./commands/memory"
import { renderInstanceHelp } from "./commands/metadata"
import { context, status } from "./commands/system"
import { fail, INSTANCE_CLI_VERSION, reportError, writeText } from "./output"
import { type ApiConnection, createInstanceApiClient, runInstanceCli } from "./run"

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (!command || isHelp(command)) return writeText(renderInstanceHelp())
  if (command === "--version" || command === "version") {
    return writeText(`sixb CLI ${INSTANCE_CLI_VERSION}`)
  }
  const connection = envConnection()
  if (command === "status") return status(rest, connection)
  if (command === "context") return context(rest)
  if (command === "memory") return memory(rest, connection)
  if (command === "history") return history(createInstanceApiClient(connection), rest)
  if (!isInstanceCommand(command)) fail(`Unknown command '${command}'. Run 'sixb --help'.`)

  await runInstanceCli({ args, connection })
}

function envConnection(): ApiConnection {
  const baseUrl = process.env.SIXB_API_URL || process.env.SIXB_API_BASE_URL || ""
  const token = process.env.SIXB_API_TOKEN || process.env.SIXB_TOKEN || undefined
  const runId = process.env.SIXB_RUN_ID || undefined
  return {
    baseUrl,
    ...(token ? { token } : {}),
    ...(runId ? { runId } : {}),
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.exitCode = reportError(error)
}
