#!/usr/bin/env bun

import { basename } from "node:path"
import { ErrorView, HelpView, renderStatic, VersionView } from "./ui"

const args = process.argv.slice(2)
const executable = basename(process.argv[1] ?? "pario")

const VERSION = "pario v0.2.0"

function getFlag(name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`--${name}=`))
  if (direct) return direct.split("=")[1]

  const idx = args.indexOf(`--${name}`)
  if (idx >= 0) return args[idx + 1]

  return undefined
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
  "sentinel-public-origin",
  "app-public-origin",
  "outdir",
  "dir",
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
  if (executable.startsWith("create-pario")) return "create"
  if (args[0] === "db") {
    return args[1] ? `db:${args[1]}` : "db"
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
        sentinelPublicOrigin: getFlag("sentinel-public-origin"),
        appPublicOrigin: getFlag("app-public-origin"),
      })
      break
    }

    case "worker": {
      if (hasFlagValue("type") || hasFlagValue("worker")) {
        throw new Error("[ParioWorker] Use `pario worker <type>`.")
      }

      const { runWorker } = await import("./commands/worker")
      await runWorker({
        entry: getFlag("entry"),
        workerType: getCommandPositionals()[0],
      })
      break
    }

    case "api": {
      const { runApi } = await import("./commands/api")
      await runApi({
        entry: getFlag("entry"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPort: getFlag("api-port"),
        apiHost: getFlag("api-host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        atlasPublicOrigin: getFlag("atlas-public-origin"),
        sentinelPublicOrigin: getFlag("sentinel-public-origin"),
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

    case "sentinel": {
      const { runSentinel } = await import("./commands/sentinel")
      await runSentinel({
        entry: getFlag("entry"),
        port: getFlag("port"),
        host: getFlag("host"),
        apiPublicOrigin: getFlag("api-public-origin"),
        sentinelPublicOrigin: getFlag("sentinel-public-origin"),
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

    case "scheduler": {
      const { runScheduler } = await import("./commands/scheduler")
      await runScheduler({ entry: getFlag("entry") })
      break
    }

    case "orchestrator": {
      const { runOrchestrator } = await import("./commands/orchestrator")
      await runOrchestrator({ entry: getFlag("entry") })
      break
    }

    case "functions": {
      const { runFunctions } = await import("./commands/functions")
      await runFunctions({ entry: getFlag("entry") })
      break
    }

    case "rules": {
      const { runRules } = await import("./commands/rules")
      await runRules({ entry: getFlag("entry") })
      break
    }

    case "check": {
      const { runCheck } = await import("./commands/check")
      await runCheck({ entry: getFlag("entry") })
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

    case "panasonic:login": {
      try {
        // Resolve from cwd so the user's project dependencies are used, not the CLI's
        const pkg = "@pario/connector-panasonic"
        const resolved = Bun.resolveSync(pkg, process.cwd())
        const mod = (await import(resolved)) as {
          panasonicLogin: (opts: { dir?: string }) => Promise<void>
        }
        await mod.panasonicLogin({ dir: getFlag("dir") })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("Cannot find module") || message.includes("Cannot find package")) {
          throw new Error(
            "@pario/connector-panasonic is not installed. Add it to your project dependencies."
          )
        }
        throw error
      }
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
      await renderStatic(<HelpView errorMessage="Usage: pario db <migrate>" />)
      process.exit(1)
      break

    default:
      await renderStatic(<HelpView errorMessage={`Unknown command: ${command}`} />)
      process.exit(1)
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error)
  await renderStatic(<ErrorView message={message} />)
  process.exit(1)
})
