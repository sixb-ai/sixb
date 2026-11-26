#!/usr/bin/env node

// The single Sixb CLI: covers the full Sixb API, authentication/profiles, and delegates
// project-local framework commands (`dev`, `serve`, `check`, `typegen`, `build`, `deploy`, ...)
// to the repo's `@sixb/project-cli` (`sixb-project`).
import { isHelp, requestsHelp } from "./arguments"
import { isInstanceCommand } from "./commands"
import { login, logout, profile } from "./commands/auth"
import { renderInstanceHelp } from "./commands/metadata"
import { status } from "./commands/status"
import { findProjectCli, PROJECT_COMMANDS, runProjectCli } from "./delegate"
import { fail, INSTANCE_CLI_VERSION, reportError, writeText } from "./output"
import { resolveProfile } from "./profiles"
import { createInstanceApiClient, runInstanceCli } from "./run"

const CONNECTION_FLAGS = new Set(["api-url", "profile", "token"])

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args

  // `sixb` alone in an interactive terminal launches the TUI when `@sixb/project-cli` is available.
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const projectCli = findProjectCli()
      if (projectCli) {
        process.exitCode = await runProjectCli(projectCli, [])
        return
      }
    }
    return writeText(renderInstanceHelp())
  }

  if (isHelp(command)) {
    if (rest.length > 0 && isInstanceCommand(rest[0] ?? "")) {
      await runInstanceCli({ args: [...rest, "--help"], connection: { baseUrl: "" } })
      return
    }
    if (rest.length > 0 && PROJECT_COMMANDS.has(rest[0] ?? "")) {
      const projectCli = findProjectCli()
      if (projectCli) {
        process.exitCode = await runProjectCli(projectCli, ["help", ...rest])
        return
      }
    }
    return writeText(renderInstanceHelp())
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return writeText(`sixb CLI ${INSTANCE_CLI_VERSION}`)
  }

  if (command === "login") return login(rest)
  if (command === "logout") return logout(rest)
  if (command === "profile") return profile(rest)

  if (isInstanceCommand(command)) {
    const { commandArgs, apiUrl, profile: profileName, token } = extractConnectionOptions(args)
    if (requestsHelp(commandArgs)) {
      await runInstanceCli({ args: commandArgs, connection: { baseUrl: "" } })
      return
    }
    const resolved = await resolveProfile({
      ...(apiUrl ? { apiUrl } : {}),
      ...(profileName ? { profile: profileName } : {}),
      ...(token ? { token } : {}),
      defaultApiUrl: "",
    })
    const connection = {
      baseUrl: resolved.apiUrl,
      ...(resolved.token ? { token: resolved.token } : {}),
      ...(resolved.runId ? { runId: resolved.runId } : {}),
    }
    if (command === "status") {
      return status(createInstanceApiClient(connection), commandArgs.slice(1), {
        ...(resolved.token ? { authenticated: true } : {}),
        ...(resolved.profile ? { profile: resolved.profile } : {}),
        ...(resolved.source === "default" ? {} : { source: resolved.source }),
      })
    }
    await runInstanceCli({ args: commandArgs, connection })
    return
  }

  const projectCli = findProjectCli()
  if (projectCli && PROJECT_COMMANDS.has(command)) {
    process.exitCode = await runProjectCli(projectCli, args)
    return
  }

  if (PROJECT_COMMANDS.has(command)) {
    fail(
      `Command '${command}' requires @sixb/project-cli.`,
      "runtime_unavailable",
      "Run inside a Sixb project with @sixb/project-cli installed, or install it globally."
    )
  }

  fail(`Unknown command '${command}'. Run 'sixb --help'.`)
}

function extractConnectionOptions(args: readonly string[]): {
  readonly commandArgs: readonly string[]
  readonly apiUrl?: string
  readonly profile?: string
  readonly token?: string
} {
  const commandArgs: string[] = []
  const values: Record<string, string | undefined> = {}

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--") {
      commandArgs.push(...args.slice(index))
      break
    }
    if (!argument?.startsWith("--")) {
      if (argument !== undefined) commandArgs.push(argument)
      continue
    }

    const equalsIndex = argument.indexOf("=")
    const name = argument.slice(2, equalsIndex < 0 ? undefined : equalsIndex)
    if (!CONNECTION_FLAGS.has(name)) {
      commandArgs.push(argument)
      continue
    }

    if (values[name] !== undefined) {
      fail(`--${name} may only be provided once.`)
    }

    const value = equalsIndex < 0 ? args[++index] : argument.slice(equalsIndex + 1)
    if (!value || value.startsWith("--")) {
      fail(`--${name} requires a value.`)
    }
    values[name] = value
  }

  if (values["api-url"] && values.profile) {
    fail("--api-url and --profile cannot be used together.")
  }

  return {
    commandArgs,
    ...(values["api-url"] ? { apiUrl: values["api-url"] } : {}),
    ...(values.profile ? { profile: values.profile } : {}),
    ...(values.token ? { token: values.token } : {}),
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  process.exitCode = reportError(error)
}
