import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { DeployConfig, DeployScript, DeployStatus, DeployTarget } from "@sixb/core/deploy"
import { migrateSqliteStorage } from "@sixb/sqlite"
import { runScriptCommand } from "../src/commands/run"
import { parseCliArgs } from "../src/lib/command-line"
import { runInProcess } from "./shared/in-process"

const fixtureSixb = pathToFileURL(
  resolve(import.meta.dir, "fixtures", "shared", "createFixtureSixb.ts")
).href

const sqliteFixtureSixb = pathToFileURL(
  resolve(import.meta.dir, "fixtures", "shared", "createSqliteFixtureSixb.ts")
).href

const CLI = resolve(import.meta.dir, "..", "src", "index.tsx")

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  delete (globalThis as { __sixbRunDeploy?: unknown }).__sixbRunDeploy
})

/** A project in a temporary directory: an in-memory host, and the files given. */
async function project(files: Record<string, string>, config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sixb-cli-run-"))
  tempDirs.push(dir)
  await writeFile(
    join(dir, "sixb.config.ts"),
    config ??
      `import { createFixtureSixb } from ${JSON.stringify(fixtureSixb)}
export const sixb = () => createFixtureSixb({ projectId: "cli-run" })
`
  )
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

async function run(cwd: string, options: Partial<Parameters<typeof runScriptCommand>[0]> = {}) {
  let exitCode: number | undefined
  const result = await runInProcess(async () => {
    exitCode = await runScriptCommand({ cwd, script: "scripts/fix.ts", args: [], ...options })
  })
  return { ...result, exitCode }
}

const REPORT = `export default async ({ sixb, args, signal }) => {
  console.log(JSON.stringify({ args, executor: sixb.execution.executor.type, source: sixb.execution.source, aborted: signal.aborted }))
}
`

describe("sixb run", () => {
  test("passes everything after the script to it, sixb's own flags included", () => {
    expect(
      parseCliArgs(["run", "--entry", "app.ts", "scripts/fix.ts", "--yes", "--help", "--", "x"])
    ).toMatchObject({
      kind: "command",
      id: "run",
      options: { entry: "app.ts" },
      positionals: ["scripts/fix.ts", "--yes", "--help", "--", "x"],
    })
    expect(parseCliArgs(["run", "--help"])).toMatchObject({ kind: "help" })
    expect(() => parseCliArgs(["run"])).toThrow("Invalid arguments for 'run'")
  })

  test("calls the default export with its arguments, as a script execution", async () => {
    const cwd = await project({ "scripts/fix.ts": REPORT })

    const result = await run(cwd, { args: ["--dry-run", "2026-01-01"] })

    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output.trim())).toEqual({
      args: ["--dry-run", "2026-01-01"],
      executor: "script",
      source: { type: "script", path: "scripts/fix.ts" },
      aborted: false,
    })
    expect(result.stderr).toContain("scripts/fix.ts finished in")
  })

  test("exits 1 when the script throws", async () => {
    const cwd = await project({
      "scripts/fix.ts": 'export default async () => { throw new Error("boom") }\n',
    })

    const result = await run(cwd)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("scripts/fix.ts failed after")
  })

  test("refuses a module without a default export to run", async () => {
    const cwd = await project({ "scripts/fix.ts": "export const fix = () => {}\n" })

    const result = await run(cwd)

    expect(String(result.error)).toContain("scripts/fix.ts has no default export to run")
  })

  test("refuses a script outside the project, and one that is not there", async () => {
    const cwd = await project({})
    const outside = await project({ "fix.ts": REPORT })

    expect(String((await run(cwd, { script: join(outside, "fix.ts") })).error)).toContain(
      "is outside the project"
    )
    expect(String((await run(cwd, { script: "scripts/missing.ts" })).error)).toContain(
      "No script at scripts/missing.ts"
    )
  })

  // Guard proof: drop the `listProjectModules` check in `projectScript`, and the action file runs
  // as a script; deployed, it would also be left where the next restart loads it as a definition.
  test("refuses a script in a folder Sixb loads definitions from", async () => {
    const cwd = await project({ "actions/fix.ts": REPORT })

    const result = await run(cwd, { script: "actions/fix.ts" })

    expect(String(result.error)).toContain("actions/fix.ts is in a folder Sixb loads definitions")
    expect(result.output).toBe("")
  })

  // Guard proof: return 1 from the catch in `runHere` whatever the signal, as it first did, and
  // a script stopped by Ctrl-C reports a failure.
  test("exits 130 when Ctrl-C stops a script that throws on its aborted signal", async () => {
    const cwd = await project({
      "scripts/fix.ts": `export default async ({ signal }) => {
  process.emit("SIGINT", "SIGINT")
  signal.throwIfAborted()
}
`,
    })

    const result = await run(cwd)

    expect(result.exitCode).toBe(130)
    expect(result.stderr).toContain("scripts/fix.ts stopped after")
    expect(result.stderr).not.toContain("failed")
  })

  // Guard proof: let a hangup only abort the signal, as Ctrl-C does, and this script, which never
  // looks at it, keeps running until the bound kills it.
  test("exits at once when its connection hangs up, whatever the script does", async () => {
    const cwd = await project({
      "scripts/fix.ts": "export default () => new Promise(() => setInterval(() => {}, 1000))\n",
    })
    const child = Bun.spawn([process.execPath, CLI, "run", "scripts/fix.ts"], {
      cwd,
      stdout: "ignore",
      stderr: "pipe",
    })
    const bound = setTimeout(() => child.kill("SIGKILL"), 8_000)
    try {
      const reader = child.stderr.getReader()
      let stderr = ""
      while (!stderr.includes("scripts/fix.ts")) {
        const chunk = await reader.read()
        if (chunk.done) break
        stderr += new TextDecoder().decode(chunk.value)
      }
      child.kill("SIGHUP")

      expect(await child.exited).toBe(129)
    } finally {
      clearTimeout(bound)
    }
  }, 10_000)

  /** A project on SQLite storage in its `.sixb/`, which `sixb db migrate` has run on or not. */
  async function sqliteProject(migrated: boolean): Promise<string> {
    const cwd = await project(
      { "scripts/fix.ts": 'export default async () => console.log("ran")\n' },
      `import { join } from "node:path"
import { createSqliteFixtureSixb } from ${JSON.stringify(sqliteFixtureSixb)}
export const sixb = () =>
  createSqliteFixtureSixb({ projectId: "cli-run", path: join(import.meta.dir, ".sixb") })
`
    )

    if (migrated) await migrateSqliteStorage(join(cwd, ".sixb"))
    return cwd
  }

  // Storage with migrators, as every real project has: the fixture above has none, so its schema
  // is valid without a check. Guard proof: go back to `host.checkReadiness()` in `runHere`, whose
  // first answer is "validation is in progress", and this run is refused.
  test("runs once storage is migrated", async () => {
    const cwd = await sqliteProject(true)

    const result = await run(cwd)

    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("ran")
  })

  // Guard proof: drop the schema check in `runHere`, and the script runs against storage that was
  // never migrated.
  test("runs nothing until storage is migrated", async () => {
    const cwd = await sqliteProject(false)

    const result = await run(cwd)

    expect(String(result.error)).toContain("cli-run's storage is not usable")
    expect(String(result.error)).toContain("Run `sixb db migrate`")
    expect(result.output).not.toContain("ran")
  })
})

describe("sixb run --deployed", () => {
  /** A project whose sixb.deploy.ts names a target that records the runs it is asked for. */
  async function deployedProject(status: DeployStatus) {
    const runs: DeployScript[] = []
    const target: DeployTarget = {
      kind: "test",
      location: "sixb@test-server",
      listenAddress: (service) => ({ host: "127.0.0.1", port: service === "app" ? 3001 : 3002 }),
      deploy: async () => {},
      status: async () => status,
      logs: async () => {},
      control: async () => {},
      check: async () => [],
      run: async (script) => {
        runs.push(script)
        return 7
      },
    }
    const config: DeployConfig = { name: "northline", domain: "example.com", target }
    ;(globalThis as { __sixbRunDeploy?: unknown }).__sixbRunDeploy = config
    const cwd = await project({
      "scripts/fix.ts": REPORT,
      "sixb.deploy.ts": "export default globalThis.__sixbRunDeploy\n",
    })
    return { cwd, runs }
  }

  const deployed: DeployStatus = {
    release: {
      commit: "3f2a91c4e0b1d2c3",
      ref: "main",
      deployedAt: "2026-11-11T00:00:00.000Z",
      deployedBy: "someone",
    },
    running: true,
    processes: [],
  }

  test("sends the file and its arguments to the deployment", async () => {
    const { cwd, runs } = await deployedProject(deployed)

    const result = await run(cwd, { deployed: true, yes: true, args: ["--dry-run"] })

    expect(result.error).toBeUndefined()
    expect(result.exitCode).toBe(7)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ path: "scripts/fix.ts", args: ["--dry-run"] })
    expect(new TextDecoder().decode(runs[0]?.source)).toBe(REPORT)
  })

  // Guard proof: return true from `confirm` without a terminal, and the run goes through.
  test("asks first, so without a terminal it needs --yes", async () => {
    const { cwd, runs } = await deployedProject(deployed)

    const isTTY = process.stdin.isTTY
    process.stdin.isTTY = false
    try {
      const result = await run(cwd, { deployed: true })

      expect(String(result.error)).toContain("Running on the deployment needs a yes")
      expect(runs).toEqual([])
    } finally {
      process.stdin.isTTY = isTTY
    }
  })

  test("refuses --entry, since the deployment runs with its own configuration", async () => {
    const { cwd, runs } = await deployedProject(deployed)

    const result = await run(cwd, { deployed: true, yes: true, entry: "other.config.ts" })

    expect(String(result.error)).toContain("--entry applies to a run here")
    expect(runs).toEqual([])
  })

  test("refuses when nothing is deployed", async () => {
    const { cwd, runs } = await deployedProject({ release: null, running: false, processes: [] })

    const result = await run(cwd, { deployed: true, yes: true })

    expect(String(result.error)).toContain("Nothing named northline is deployed")
    expect(runs).toEqual([])
  })
})
