import { fail, isInstanceCommand, reportError, runInstanceCli } from "@sixb/cli-core"
import { resolveProfile } from "./profiles"

const CONNECTION_FLAGS = new Set(["api-url", "profile", "token"])

export function isLocalInstanceCommand(command: string): boolean {
  return isInstanceCommand(command)
}

export async function runLocalInstanceCommand(args: readonly string[]): Promise<void> {
  try {
    const { commandArgs, apiUrl, profile, token } = extractConnectionOptions(args)
    const resolved = await resolveProfile({ apiUrl, profile, token })
    await runInstanceCli({
      args: commandArgs,
      mode: {
        kind: "local",
        baseUrl: resolved.apiUrl,
        ...(resolved.token ? { token: resolved.token } : {}),
        ...(resolved.profile ? { profile: resolved.profile } : {}),
      },
    })
  } catch (error) {
    process.exitCode = reportError(error)
  }
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
