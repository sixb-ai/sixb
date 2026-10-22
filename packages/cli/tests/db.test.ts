import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { runDbMigrate } from "../src/commands/db-migrate"
import { runDbPrepare } from "../src/commands/db-prepare"
import { FAST_CLI_TIMEOUT_MS, readLogEntries, runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

const entry = resolve(import.meta.dir, "fixtures", "db-project", "sixb.config.ts")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Runs a db command in this process against the db-project fixture, which logs what storage did. */
async function runLogged(command: () => Promise<void>) {
  const logPath = join(await tempDir("sixb-cli-db-"), "operations.log")
  const result = await runInProcess(() => {
    process.env.SIXB_CLI_TEST_LOG = logPath
    return command()
  })
  return { ...result, logEntries: await readLogEntries(logPath) }
}

const migratedThenPrepared = [
  { type: "storage.migrate" },
  { type: "storage.prepare", projectId: "cli-db-project", objectTypes: 1 },
]

describe("sixb db", () => {
  test("prepares the loaded ontology only after adapter migrations", async () => {
    const result = await runLogged(() => runDbPrepare({ entry }))

    expect(result.error).toBeUndefined()
    expect(result.logEntries).toEqual(migratedThenPrepared)
    expect(result.output).toContain("Prepared 1 object types")
  })

  // Guard removal: omit the ontology context in runDbMigrate; storage.prepare is missing.
  test("runs adapter migrations for the configured runtime", async () => {
    const result = await runLogged(() => runDbMigrate({ entry }))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Database migrations complete")
    expect(result.output.replace(/\s+/g, " ")).toContain("storage migrated")
    expect(result.logEntries).toEqual(migratedThenPrepared)
  })

  // A child process: which entry runs depends on the working directory.
  test("uses the default built runtime when present and closes providers", async () => {
    const projectRoot = await tempDir("sixb-cli-db-built-")
    const builtDir = join(projectRoot, ".sixb", "dist")
    await mkdir(builtDir, { recursive: true })
    await writeFile(
      join(projectRoot, "sixb.config.ts"),
      'throw new Error("source entry should not load when a default build exists")\n'
    )
    const prodRoles = resolve(import.meta.dir, "fixtures", "prod-roles", "sixb.config.ts")
    await writeFile(
      join(builtDir, "sixb.config.js"),
      `export { sixb } from ${JSON.stringify(pathToFileURL(prodRoles).href)}\n`
    )
    const logPath = join(projectRoot, "operations.log")

    const result = await runCliToCompletion({
      cmd: ["bun", resolve(import.meta.dir, "..", "src", "index.tsx"), "db", "migrate"],
      cwd: projectRoot,
      env: { SIXB_CLI_TEST_LOG: logPath },
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Database migrations complete")
    expect(result.stdout).toContain("cli-prod-roles")
    const logEntries = await readLogEntries(logPath)
    expect(logEntries).toContainEqual({ type: "storage:migrate" })
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
