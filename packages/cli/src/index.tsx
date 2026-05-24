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
      const { runWorker } = await import("./commands/worker")
      await runWorker({ entry: getFlag("entry"), worker: getFlag("worker") })
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

    case "start": {
      const { runStart } = await import("./commands/start")
      await runStart({
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
