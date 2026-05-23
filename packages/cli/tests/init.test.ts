import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

function runInit(targetDir: string): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "init", targetDir],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

describe("sixb init", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test("scaffolds the updated basic template with a root app folder", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-init-"))
    tempDirs.push(tempDir)

    const targetDir = join(tempDir, "starter")
    const result = runInit(targetDir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")

    await stat(join(targetDir, "sixb.config.ts"))
    await stat(join(targetDir, "app", "layout.tsx"))
    await stat(join(targetDir, "app", "page.tsx"))
    await stat(join(targetDir, "app", "globals.css"))
    await stat(join(targetDir, "app", "public", "favicon.svg"))
    await stat(join(targetDir, "tsconfig.json"))

    const configSource = await readFile(join(targetDir, "sixb.config.ts"), "utf-8")
    expect(configSource).toContain('id: "starter"')
    expect(configSource).toContain("broker:")
    expect(configSource).toContain("storage:")
    expect(configSource).not.toContain("providers:")

    const packageJson = JSON.parse(await readFile(join(targetDir, "package.json"), "utf-8")) as {
      name: string
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }

    expect(packageJson.name).toBe("starter")
    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit")
    expect(packageJson.dependencies["@sixb/client"]).toBe("latest")
    expect(packageJson.dependencies.react).toBe("^19.0.0")
    expect(packageJson.dependencies["react-router-dom"]).toBe("^7.13.0")
  })
})
