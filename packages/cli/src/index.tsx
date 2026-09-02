#!/usr/bin/env bun

import { join } from "node:path"
import { CliError } from "@sixb/cli-core"
import {
  booleanOption,
  type CliOptionName,
  CliUsageError,
  parseCliArgs,
  repeatedOption,
  stringOption,
  wantsManagementJson,
} from "./lib/command-line"
import { errorMessage, SixbApiError } from "./lib/errors"
import { CommandHelpView, HelpView, renderCliError, renderStatic, VersionView } from "./ui"

const args = process.argv.slice(2)

/**
 * Lowest Bun we test against, kept in step with `engines.bun` in every published manifest.
 * `bun install` only warns about `engines`, so without this check an older Bun fails later on
 * whichever API it happens to be missing, far from the cause.
 */
const MINIMUM_BUN_VERSION = "1.3.0"

assertSupportedBunVersion()

const VERSION = `sixb v${await readPackageVersion()}`

function assertSupportedBunVersion(): void {
  const current = typeof Bun === "undefined" ? undefined : Bun.version
  if (!current) {
    console.error("[Sixb] The sixb CLI requires Bun. See https://bun.sh to install it.")
    process.exit(1)
  }

  if (compareVersions(current, MINIMUM_BUN_VERSION) >= 0) return

  console.error(
    `[Sixb] Bun ${MINIMUM_BUN_VERSION} or newer is required; this is Bun ${current}. ` +
      "Run `bun upgrade` and try again."
  )
  process.exit(1)
}

/** Numeric compare of the leading `major.minor.patch`, ignoring any prerelease suffix. */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    (value.split("-")[0] ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0)
  const a = parse(left)
  const b = parse(right)

  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

async function readPackageVersion(): Promise<string> {
  const fallbackVersion = "0.1.0"

  try {
    const packageJson = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
      version?: unknown
    }
    return typeof packageJson.version === "string" ? packageJson.version : fallbackVersion
  } catch {
    return fallbackVersion
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(args)
  if (parsed.kind === "version") {
    await renderStatic(<VersionView version={VERSION} />)
    return
  }
  if (parsed.kind === "help") {
    if (parsed.help.path.length === 0) await renderStatic(<HelpView />)
    else await renderStatic(<CommandHelpView help={parsed.help} />)
    return
  }
  if (parsed.kind === "instance") {
    const { runLocalInstanceCommand } = await import("./lib/instance-command")
    await runLocalInstanceCommand(parsed.args)
    return
  }

  const { options, positionals } = parsed
  const getFlag = (name: CliOptionName) => stringOption(options, name)
  const getFlags = (name: CliOptionName) => repeatedOption(options, name)
  const hasFlag = (name: CliOptionName) => booleanOption(options, name)

  switch (parsed.id) {
    case "dev": {
      const { runDev } = await import("./commands/dev")
      await runDev({
        entry: getFlag("entry"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPort: getFlag("api-port"),
        apiHost: getFlag("api-host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        atlasPublicOrigin: getFlag("atlas-public-origin"),
        appPublicOrigin: getFlag("app-public-origin"),
        agentTurnTimeout: getFlag("agent-turn-timeout"),
        concurrency: getFlags("concurrency"),
      })
      break
    }

    case "worker": {
      const { runWorker } = await import("./commands/worker")
      await runWorker({
        entry: getFlag("entry"),
        noMigrate: hasFlag("no-migrate"),
        workerType: positionals[0],
        apiPublicOrigin: getFlag("api-public-origin"),
        agentTurnTimeout: getFlag("agent-turn-timeout"),
        concurrency: getFlag("concurrency"),
      })
      break
    }

    case "worker-group": {
      const { runWorkerGroup } = await import("./commands/worker-group")
      await runWorkerGroup({
        entry: getFlag("entry"),
        noMigrate: hasFlag("no-migrate"),
        workerTypes: positionals,
        apiPublicOrigin: getFlag("api-public-origin"),
        agentTurnTimeout: getFlag("agent-turn-timeout"),
        concurrency: getFlags("concurrency"),
      })
      break
    }

    case "api": {
      const { runApi } = await import("./commands/api")
      await runApi({
        entry: getFlag("entry"),
        noMigrate: hasFlag("no-migrate"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPort: getFlag("api-port"),
        apiHost: getFlag("api-host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        atlasPublicOrigin: getFlag("atlas-public-origin"),
        appPublicOrigin: getFlag("app-public-origin"),
      })
      break
    }

    case "atlas": {
      const { runAtlas } = await import("./commands/atlas")
      await runAtlas({
        entry: getFlag("entry"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        atlasPublicOrigin: getFlag("atlas-public-origin"),
      })
      break
    }

    case "app": {
      const { runApp } = await import("./commands/app")
      await runApp({
        entry: getFlag("entry"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        appPublicOrigin: getFlag("app-public-origin"),
      })
      break
    }

    case "login": {
      const { runLogin } = await import("./commands/login")
      await runLogin({
        apiUrl: positionals[0],
        profile: getFlag("profile"),
        tokenStdin: hasFlag("token-stdin"),
        json: hasFlag("json"),
      })
      break
    }

    case "logout": {
      const { runLogout } = await import("./commands/logout")
      await runLogout({ profile: getFlag("profile"), json: hasFlag("json") })
      break
    }

    case "status": {
      const { runStatus } = await import("./commands/status")
      await runStatus({
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
        profile: getFlag("profile"),
        json: hasFlag("json"),
      })
      break
    }

    case "profile:list":
    case "profile:show":
    case "profile:use": {
      const { runProfile } = await import("./commands/profile")
      await runProfile({
        action: parsed.id.slice("profile:".length),
        name: positionals[0],
        json: hasFlag("json"),
      })
      break
    }

    case "token:list":
    case "token:create":
    case "token:revoke": {
      const { runToken } = await import("./commands/token")
      const action = parsed.id.slice("token:".length)
      await runToken({
        action,
        positionals: [action, ...positionals],
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
        profile: getFlag("profile"),
        id: getFlag("id"),
        name: getFlag("name"),
        expiresAt: getFlag("expires-at"),
        expiresIn: getFlag("expires-in"),
        groupIds: getFlags("group"),
        json: hasFlag("json"),
      })
      break
    }

    case "service-account:list":
    case "service-account:create":
    case "service-account:disable":
    case "service-account:token:list":
    case "service-account:token:create":
    case "service-account:token:revoke": {
      const { runServiceAccount } = await import("./commands/service-account")
      const commandPath = parsed.id.split(":").slice(1)
      await runServiceAccount({
        positionals: [...commandPath, ...positionals],
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
        profile: getFlag("profile"),
        id: getFlag("id"),
        name: getFlag("name"),
        description: getFlag("description"),
        expiresAt: getFlag("expires-at"),
        expiresIn: getFlag("expires-in"),
        groupIds: getFlags("group"),
        json: hasFlag("json"),
      })
      break
    }

    case "scheduler": {
      const { runScheduler } = await import("./commands/scheduler")
      await runScheduler({ entry: getFlag("entry"), noMigrate: hasFlag("no-migrate") })
      break
    }

    case "orchestrator": {
      const { runOrchestrator } = await import("./commands/orchestrator")
      await runOrchestrator({ entry: getFlag("entry"), noMigrate: hasFlag("no-migrate") })
      break
    }

    case "rules": {
      const { runRules } = await import("./commands/rules")
      await runRules({ entry: getFlag("entry"), noMigrate: hasFlag("no-migrate") })
      break
    }

    case "check": {
      const { runCheck } = await import("./commands/check")
      await runCheck({ entry: getFlag("entry") })
      break
    }

    case "typegen": {
      const { runTypegen } = await import("./commands/typegen")
      await runTypegen({ entry: getFlag("entry") })
      break
    }

    case "build": {
      const { runBuild } = await import("./commands/build")
      await runBuild({ entry: getFlag("entry"), outdir: getFlag("outdir") })
      break
    }

    case "db:migrate": {
      const { runDbMigrate } = await import("./commands/db-migrate")
      await runDbMigrate({ entry: getFlag("entry") })
      break
    }

    case "lake:check": {
      const { runLakeCheck } = await import("./commands/lake-check")
      await runLakeCheck({ entry: getFlag("entry") })
      break
    }

    case "lake:cleanup": {
      const { runLakeCleanup } = await import("./commands/lake-cleanup")
      await runLakeCleanup({
        entry: getFlag("entry"),
        dryRun: hasFlag("dry-run"),
        expireOlderThan: getFlag("expire-older-than"),
        deleteOlderThan: getFlag("delete-older-than"),
      })
      break
    }

    case "init": {
      const { runInit } = await import("./commands/init")
      await runInit(positionals[0])
      break
    }

    default:
      assertNever(parsed.id)
  }
}

main().catch(async (error) => {
  const exitCode = cliExitCode(error)
  if (wantsManagementJson(args)) {
    process.stderr.write(`${JSON.stringify({ error: cliErrorBody(error) })}\n`)
  } else if (error instanceof CliUsageError) {
    if (error.help.path.length === 0) {
      await renderStatic(<HelpView errorMessage={error.message} />)
    } else {
      await renderStatic(<CommandHelpView help={error.help} errorMessage={error.message} />)
    }
  } else {
    await renderCliError(error)
  }
  process.exit(exitCode)
})

function cliExitCode(error: unknown): number {
  if (error instanceof CliUsageError) return error.exitCode
  if (error instanceof CliError) return error.exitCode
  if (error instanceof SixbApiError) return 3
  if (errorMessage(error).startsWith("Usage:")) return 2
  return 1
}

function cliErrorBody(error: unknown): {
  readonly code: string
  readonly status?: number
  readonly message: string
  readonly hint?: string
  readonly issues?: readonly unknown[]
} {
  if (error instanceof CliError) return error.body
  if (error instanceof CliUsageError) {
    return { code: "invalid_arguments", message: error.message, hint: error.help.usage }
  }
  if (error instanceof SixbApiError) {
    return {
      code: "api_error",
      ...(error.status === undefined ? {} : { status: error.status }),
      message: error.message,
    }
  }
  return {
    code: errorMessage(error).startsWith("Usage:") ? "invalid_arguments" : "command_failed",
    message: errorMessage(error),
  }
}

function assertNever(value: never): never {
  throw new Error(`[SixbCLI] Command '${String(value)}' has no handler.`)
}
