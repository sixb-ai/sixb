#!/usr/bin/env bun

import { join } from "node:path"
import { HelpView, renderCliError, renderStatic, VersionView } from "./ui"

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

function getFlag(name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`))
  if (direct) return direct.split("=")[1]

  const idx = args.indexOf(`--${name}`)
  if (idx >= 0) return args[idx + 1]

  return undefined
}

function getFlags(name: string): string[] {
  const values: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === `--${name}`) {
      const value = args[index + 1]
      if (value && !value.startsWith("--")) {
        values.push(value)
        index++
      }
    } else if (arg?.startsWith(`--${name}=`)) {
      values.push(arg.slice(name.length + 3))
    }
  }

  return values
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

function hasFlagValue(name: string): boolean {
  return hasFlag(name) || args.some((arg) => arg.startsWith(`--${name}=`))
}

const flagsWithValues = new Set([
  "entry",
  "port",
  "host",
  "api-port",
  "api-host",
  "api-public-origin",
  "atlas-public-origin",
  "app-public-origin",
  "outdir",
  "dir",
  "expire-older-than",
  "delete-older-than",
  "api-url",
  "token",
  "id",
  "name",
  "description",
  "expires-at",
  "expires-in",
  "group",
])

function getCommandPositionals(): string[] {
  const values: string[] = []

  for (let index = 1; index < args.length; index++) {
    const arg = args[index]
    if (!arg) continue

    if (arg.startsWith("--")) {
      const flagName = arg.slice(2).split("=")[0] ?? ""
      if (!arg.includes("=") && flagsWithValues.has(flagName)) {
        index++
      }
      continue
    }

    values.push(arg)
  }

  return values
}

function getCommand(): string {
  if (args[0] === "db") {
    return args[1] ? `db:${args[1]}` : "db"
  }
  if (args[0] === "lake") {
    return args[1] ? `lake:${args[1]}` : "lake"
  }
  return args[0] ?? "help"
}

async function main(): Promise<void> {
  const command = getCommand()

  if (hasFlag("help") || command === "help") {
    await renderStatic(<HelpView />)
    return
  }

  if (hasFlag("version") || command === "--version" || command === "-v") {
    await renderStatic(<VersionView version={VERSION} />)
    return
  }

  switch (command) {
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
      })
      break
    }

    case "worker": {
      if (hasFlagValue("type") || hasFlagValue("worker")) {
        throw new Error("[SixbWorker] Use `sixb worker <type>`.")
      }

      const { runWorker } = await import("./commands/worker")
      await runWorker({
        entry: getFlag("entry"),
        noMigrate: hasFlag("no-migrate"),
        workerType: getCommandPositionals()[0],
        apiPublicOrigin: getFlag("api-public-origin"),
      })
      break
    }

    case "worker-group": {
      const { runWorkerGroup } = await import("./commands/worker-group")
      await runWorkerGroup({
        entry: getFlag("entry"),
        noMigrate: hasFlag("no-migrate"),
        workerTypes: getCommandPositionals(),
        apiPublicOrigin: getFlag("api-public-origin"),
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

    case "auth": {
      const { runAuth } = await import("./commands/auth")
      const positionals = getCommandPositionals()
      await runAuth({
        action: positionals[0],
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
        json: hasFlag("json"),
      })
      break
    }

    case "token": {
      const { runToken } = await import("./commands/token")
      const positionals = getCommandPositionals()
      await runToken({
        action: positionals[0],
        positionals,
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
        id: getFlag("id"),
        name: getFlag("name"),
        expiresAt: getFlag("expires-at"),
        expiresIn: getFlag("expires-in"),
        groupIds: getFlags("group"),
        json: hasFlag("json"),
      })
      break
    }

    case "service-account": {
      const { runServiceAccount } = await import("./commands/service-account")
      await runServiceAccount({
        positionals: getCommandPositionals(),
        apiUrl: getFlag("api-url"),
        token: getFlag("token"),
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
      const dir = args[1] && !args[1].startsWith("-") ? args[1] : undefined
      const { runInit } = await import("./commands/init")
      await runInit(dir)
      break
    }

    case "create": {
      const name = args[1]
      if (!name) {
        throw new Error("create requires a project name")
      }
      const { runCreate } = await import("./commands/init")
      await runCreate(name)
      break
    }

    case "db":
      await renderStatic(<HelpView errorMessage="Usage: sixb db <migrate>" />)
      process.exit(1)
      break

    case "lake":
      await renderStatic(<HelpView errorMessage="Usage: sixb lake <check|cleanup>" />)
      process.exit(1)
      break

    default:
      await renderStatic(<HelpView errorMessage={`Unknown command: ${command}`} />)
      process.exit(1)
  }
}

main().catch(async (error) => {
  await renderCliError(error)
  process.exit(1)
})
