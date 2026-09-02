#!/usr/bin/env node

import {
  fail,
  INSTANCE_CLI_VERSION,
  isHelp,
  isInstanceCommand,
  renderInstanceHelp,
  reportError,
  runInstanceCli,
  writeText,
} from "@sixb/cli-core"
import { context, doctor } from "./commands/system"

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (!command || isHelp(command)) return writeText(renderInstanceHelp("sandbox"))
  if (command === "--version" || command === "version") {
    return writeText(`sixb agent CLI ${INSTANCE_CLI_VERSION}`)
  }
  if (command === "doctor") return doctor(rest, sandboxMode())
  if (command === "context") return context(rest)
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
