import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

describe("sftp connector module loading", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test("does not load ssh2 until the connector establishes a connection", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sftp-lazy-load-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")
    const entry = resolve(import.meta.dir, "..", "src", "index.ts")
    const result = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: "bun",
      packages: "external",
    })

    expect(result.success).toBe(true)

    const connectorUrl = pathToFileURL(join(outdir, "index.js")).href
    const runner = join(tempDir, "runner.ts")
    await writeFile(
      runner,
      [
        `import { sftp } from ${JSON.stringify(connectorUrl)}`,
        "",
        'const adapter = sftp({ host: "example.com", username: "demo", password: "secret" })',
        'if (adapter.type !== "sftp") throw new Error("Unexpected connector type")',
      ].join("\n")
    )

    const subprocess = Bun.spawnSync({
      cmd: [process.execPath, runner],
      cwd: tempDir,
      env: { ...process.env, NODE_PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(Buffer.from(subprocess.stderr).toString("utf8")).toBe("")
    expect(subprocess.exitCode).toBe(0)
  })
})
