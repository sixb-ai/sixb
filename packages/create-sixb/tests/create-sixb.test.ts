import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const entry = resolve(import.meta.dir, "..", "src", "index.ts")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("create-sixb", () => {
  test("shows the bun create usage", () => {
    const result = Bun.spawnSync(["bun", entry, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("bun create sixb <project-name>")
    expect(result.stderr.toString()).toBe("")
  })

  test("creates a project through @sixb/cli", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "create-sixb-"))
    tempDirs.push(tempDir)

    const result = Bun.spawnSync(["bun", entry, "starter"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")

    const projectDir = join(tempDir, "starter")
    await stat(join(projectDir, "sixb.config.ts"))
    await stat(join(projectDir, "app", "page.tsx"))
    await stat(join(projectDir, ".env.example"))

    const configSource = await readFile(join(projectDir, "sixb.config.ts"), "utf8")
    expect(configSource).toContain('const projectId = "starter"')
    expect(configSource).not.toContain("productionProviders")
    expect(configSource).toContain('path: ".sixb/ducklake-catalog.db"')
    expect(configSource).toContain("new DuckLakeStorage")

    const incrementAction = await readFile(join(projectDir, "actions", "increment.ts"), "utf8")
    expect(incrementAction).toContain('defineAction("increment")')
    expect(incrementAction).toContain(".edits(")
    expect(incrementAction).not.toContain(".writeback(")

    const packageJson = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8")) as {
      name?: string
      dependencies?: Record<string, string>
    }
    expect(packageJson.name).toBe("starter")
    expect(packageJson.dependencies?.["@sixb/cli"]).toBe("latest")
  })
})
