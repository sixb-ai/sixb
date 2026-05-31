import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function runDbCommand(
  subcommand: "migrate",
  options: { cwd?: string; entry?: string | null } = {}
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  logEntries: Array<Record<string, unknown>>
}> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", "db-project", "pario.config.ts")
  const entryArgs = options.entry === null ? [] : ["--entry", options.entry ?? fixtureEntry]
  const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-db-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "db", subcommand, ...entryArgs],
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      PARIO_CLI_TEST_LOG: logPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const logSource = await readFile(logPath, "utf-8").catch(() => "")

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
    logEntries: logSource
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

async function createProjectWithDefaultBuiltEntry(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "pario-cli-db-built-"))
  tempDirs.push(projectRoot)
  const builtDir = join(projectRoot, ".pario", "dist")
  await mkdir(builtDir, { recursive: true })

  await writeFile(
    join(projectRoot, "pario.config.ts"),
    'throw new Error("source entry should not load when a default build exists")\n'
  )

  const fixtureEntry = resolve(import.meta.dir, "fixtures", "prod-roles", "pario.config.ts")
  await writeFile(
    join(builtDir, "pario.config.js"),
    `export { pario } from ${JSON.stringify(pathToFileURL(fixtureEntry).href)}\n`
  )

  return projectRoot
}

describe("pario db", () => {
  test("runs adapter migrations for the configured runtime", async () => {
    const result = await runDbCommand("migrate")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Database migrations complete")
    expect(result.stdout).toContain("Storage")
    expect(result.stdout).toContain("migrated")
    expect(result.logEntries).toEqual([{ type: "storage.migrate" }])
  })

  test("uses the default built runtime when present and closes providers", async () => {
    const projectRoot = await createProjectWithDefaultBuiltEntry()
    const result = await runDbCommand("migrate", { cwd: projectRoot, entry: null })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Database migrations complete")
    expect(result.stdout).toContain("cli-prod-roles")
    expect(result.logEntries).toContainEqual({ type: "storage:migrate" })
    expect(result.logEntries).toContainEqual({ type: "queues:close" })
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
