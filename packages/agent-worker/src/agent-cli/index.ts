#!/usr/bin/env node

import { isHelp } from "./arguments"
import { dispatch } from "./commands"
import { MAIN_HELP } from "./commands/metadata"
import { AGENT_CLI_VERSION, reportError, writeText } from "./output"

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args
  if (!command || isHelp(command)) return writeText(MAIN_HELP)
  if (command === "--version" || command === "version") {
    return writeText(`sixb agent CLI ${AGENT_CLI_VERSION}`)
  }
  await dispatch(command, rest)
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.exitCode = reportError(error)
}
