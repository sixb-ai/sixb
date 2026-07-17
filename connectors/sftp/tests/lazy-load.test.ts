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

  test("uses ssh2 JavaScript crypto under Bun", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sftp-js-crypto-"))
    tempDirs.push(tempDir)
    const sshModule = resolve(import.meta.dir, "..", "src", "ssh.ts")
    const sshModuleUrl = pathToFileURL(sshModule).href
    const runner = join(tempDir, "runner.ts")

    await writeFile(
      runner,
      [
        'import { createRequire } from "node:module"',
        'import { dirname, join } from "node:path"',
        `import { createSshClient } from ${JSON.stringify(sshModuleUrl)}`,
        "",
        "const client = await createSshClient()",
        "client.end()",
        `const localRequire = createRequire(${JSON.stringify(sshModuleUrl)})`,
        'const ssh2Entry = localRequire.resolve("ssh2")',
        'const crypto = localRequire(join(dirname(ssh2Entry), "protocol", "crypto.js"))',
        'if (crypto.bindingAvailable !== false) throw new Error("ssh2 native crypto was loaded")',
      ].join("\n")
    )

    const subprocess = Bun.spawnSync({
      cmd: [process.execPath, runner],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(Buffer.from(subprocess.stderr).toString("utf8")).toBe("")
    expect(subprocess.exitCode).toBe(0)
  })
})
