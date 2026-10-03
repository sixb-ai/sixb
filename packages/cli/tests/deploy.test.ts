import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DeployConfig, DeployTarget } from "@sixb/core/deploy"
import { parseCliArgs } from "../src/lib/command-line"
import { buildDeployRelease, type DeployRelease } from "../src/lib/deploy-release"
import { productionRoleFacts } from "../src/lib/production-roles"
import { runCliToCompletion } from "./shared/cli-process"

const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const fixtureProject = resolve(import.meta.dir, "fixtures", "deploy-project")

const ports = { atlas: 3000, app: 3001, api: 3002 } as const

const target: DeployTarget = {
  kind: "test",
  location: "sixb@test-server",
  listenAddress: (service) => ({ host: "127.0.0.1", port: ports[service] }),
}

function release(overrides: Partial<DeployConfig> = {}): DeployRelease {
  return buildDeployRelease({ name: "northline", domain: "example.com", target, ...overrides })
}

function service(built: DeployRelease, name: string) {
  const found = built.services.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`No ${name} service in the release.`)
  return found
}

function commandLine(built: DeployRelease, name: string): string {
  const { command } = service(built, name)
  return [command.program, ...command.args].join(" ")
}

describe("deploy release", () => {
  test("runs every Sixb service by default, rules included", () => {
    const built = release()

    expect(built.services.map((entry) => [entry.name, entry.role])).toEqual([
      ["api", "api"],
      ["atlas", "atlas"],
      ["app", "app"],
      ["orchestrator", "orchestrator"],
      ["scheduler", "scheduler"],
      ["rules", "rules"],
      ["workers", "worker-group"],
    ])
    expect(commandLine(built, "api")).toBe("sixb api --host 127.0.0.1 --port 3002 --no-migrate")
    expect(commandLine(built, "atlas")).toBe("sixb atlas --host 127.0.0.1 --port 3000")
    expect(commandLine(built, "rules")).toBe("sixb rules --no-migrate")
    expect(commandLine(built, "workers")).toBe("sixb worker-group --no-migrate")
    expect(built.steps).toEqual({
      build: [{ program: "sixb", args: ["build"] }],
      beforeStart: [
        { program: "sixb", args: ["db", "migrate"] },
        { program: "sixb", args: ["lake", "check"] },
      ],
    })
  })

  // Reproduce: rename `--no-migrate` or `--agent-turn-timeout` in command-line.ts, or drop an
  // option from a role's command, and this fails for the release that uses it.
  test("starts every Sixb service with a command the CLI accepts", () => {
    const built = release({
      services: {
        workers: {
          types: ["sync", "agent"],
          agentTurnTimeout: "30m",
          concurrency: { sync: 2, agent: 8 },
        },
      },
    })

    for (const entry of built.services) {
      if (entry.role === "custom") continue
      const parsed = parseCliArgs(entry.command.args)
      expect(parsed.kind).toBe("command")
      if (parsed.kind !== "command") continue
      expect(parsed.id).toBe(entry.role)
      expect(parsed.options["no-migrate"] === true).toBe(
        productionRoleFacts(entry.role).usesStorageSchema
      )
    }
    for (const step of [...built.steps.build, ...built.steps.beforeStart]) {
      expect(parseCliArgs(step.args).kind).toBe("command")
    }
    expect(commandLine(built, "workers")).toBe(
      "sixb worker-group sync agent --agent-turn-timeout 30m " +
        "--concurrency sync=2 --concurrency agent=8 --no-migrate"
    )
  })

  test("gives every service the public origins, then its own environment", () => {
    const built = release({
      env: { SIXB_ERROR_EMAIL_TO: "ops@example.com" },
      services: {
        app: { domain: "ops.example.com" },
        api: { env: { POSTGRES_POOL_MAX: "6" } },
        atlas: false,
      },
    })

    expect(built.env).toEqual({
      NODE_ENV: "production",
      SIXB_API_PUBLIC_ORIGIN: "https://northline-api.example.com",
      SIXB_APP_PUBLIC_ORIGIN: "https://ops.example.com",
      SIXB_ERROR_EMAIL_TO: "ops@example.com",
    })
    expect(service(built, "api").env).toEqual({ ...built.env, POSTGRES_POOL_MAX: "6" })
    expect(service(built, "workers").env).toEqual(built.env)
    expect(service(built, "app").http).toEqual({
      host: "127.0.0.1",
      port: 3001,
      domain: "ops.example.com",
      publicOrigin: "https://ops.example.com",
    })
    expect(built.services.some((entry) => entry.name === "atlas")).toBe(false)
  })

  test("supervises project processes with Bun", () => {
    const built = release({
      processes: {
        "nas-watcher": {
          entrypoint: "scripts/nas-watch.ts",
          args: ["--recursive"],
          env: { WATCH_MODE: "recursive" },
          process: { instances: 2, maxMemory: "256M" },
        },
      },
    })

    expect(service(built, "nas-watcher")).toEqual({
      name: "nas-watcher",
      role: "custom",
      command: { program: "bun", args: ["scripts/nas-watch.ts", "--recursive"] },
      env: { ...built.env, WATCH_MODE: "recursive" },
      instances: 2,
      process: { killTimeoutMs: 10_000, restartDelayMs: 1_000, maxMemory: "256M" },
    })
  })

  test("refuses what would collide or never resolve", () => {
    expect(() => release({ domain: undefined })).toThrow("services.api has no domain")
    expect(() => release({ services: { app: { domain: "northline-api.example.com" } } })).toThrow(
      "services.api and services.app both use northline-api.example.com"
    )
    expect(() =>
      release({ target: { ...target, listenAddress: () => ({ host: "127.0.0.1", port: 3000 }) } })
    ).toThrow("api and atlas both listen on port 3000")
    expect(() => release({ services: { workers: { agentTurnTimeout: "10 minutes" } } })).toThrow(
      "agentTurnTimeout '10 minutes' is not a duration"
    )
  })
})

describe("sixb deploy", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("prints the release as JSON", async () => {
    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "deploy", "--dry-run", "--json"],
      cwd: fixtureProject,
    })

    expect(result.exitCode).toBe(0)
    const built = JSON.parse(result.stdout) as DeployRelease
    expect(built.target).toEqual({ kind: "ssh", location: "sixb@203.0.113.10" })
    expect(built.services.map((entry) => entry.name)).toEqual([
      "api",
      "atlas",
      "app",
      "orchestrator",
      "rules",
      "workers",
    ])
    expect(service(built, "api").http?.port).toBe(3012)
    expect(service(built, "app").http?.publicOrigin).toBe("https://ops.example.com")
  })

  test("prints the release for people", async () => {
    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "deploy", "--dry-run"],
      cwd: fixtureProject,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("northline · dry run")
    expect(result.stdout).toContain("ssh sixb@203.0.113.10 · sixb.deploy.ts")
    expect(result.stdout).toContain("sixb api --host 127.0.0.1 --port 3012 --no-migrate")
    expect(result.stdout).toContain("Nothing was deployed")
  })

  test("only prints the release for now", async () => {
    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "deploy", "--json"],
      cwd: fixtureProject,
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.message).toContain("not available yet")
  })

  test("explains a missing sixb.deploy.ts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "sixb-deploy-"))
    tempDirs.push(cwd)
    const result = await runCliToCompletion({
      cmd: ["bun", cliEntry, "deploy", "--dry-run", "--json"],
      cwd,
    })

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).error.message).toContain("No sixb.deploy.ts in")
  })
})
