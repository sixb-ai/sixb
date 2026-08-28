import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readAgentCliSource, runAgentCliContractSuite } from "./agent-cli-contract"

const bashPocPath = resolve(import.meta.dir, "fixtures", "agent-cli-poc", "sixb")
const launcherPath = resolve(import.meta.dir, "..", "src", "agent-cli", "bin", "sixb")
const artifactPath = resolve(import.meta.dir, "..", "src", "agent-cli", "generated", "sixb.mjs")

runAgentCliContractSuite({
  name: "Bash POC",
  command: [bashPocPath],
  bootstrap: { binDir: resolve(bashPocPath, ".."), resolvedPath: bashPocPath },
  version: "sixb agent CLI poc-1",
})

runAgentCliContractSuite({
  name: "production launcher",
  command: [launcherPath],
  bootstrap: { binDir: resolve(launcherPath, ".."), resolvedPath: launcherPath },
  version: "sixb agent CLI 1",
})

runAgentCliContractSuite({
  name: "generated artifact on Bun",
  command: [process.execPath, artifactPath],
  version: "sixb agent CLI 1",
})

runAgentCliContractSuite({
  name: "generated artifact on Node",
  command: ["node", artifactPath],
  version: "sixb agent CLI 1",
})

describe("Sixb agent CLI Bash implementation", () => {
  test("never depends on writes to sandbox device paths", async () => {
    const source = await readAgentCliSource(bashPocPath)

    // Real agent sandboxes can reject absolute writes before Bash opens the target. This assertion
    // reproduces the regression caught when `command -v ... >/dev/null` blocked every API command.
    expect(source).not.toContain("/dev/null")
    expect(source).not.toMatch(/>\s*\/dev\//)
  })
})

describe("Sixb agent CLI generated artifact", () => {
  test("is current and has no workspace or third-party runtime imports", async () => {
    const check = Bun.spawn({
      cmd: [process.execPath, "./scripts/generate-agent-cli.ts", "--check"],
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain("Generated CLI is current")

    const artifact = await readFile(artifactPath, "utf8")
    expect(artifact).not.toMatch(/from\s+["']@sixb\//)
    expect(artifact).not.toMatch(/from\s+["']ai(?:\/|["'])/)
    expect(artifact).not.toContain("curl")
    expect(artifact).not.toContain("jq")
    expect(Buffer.byteLength(artifact)).toBeLessThan(200_000)
  })

  test("launcher falls back to Node and reports a stable error when neither runtime exists", async () => {
    const nodePath = Bun.which("node")
    const shPath = Bun.which("sh")
    const dirnamePath = Bun.which("dirname")
    if (!nodePath || !shPath || !dirnamePath) throw new Error("Expected host runtime tools.")
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-agent-cli-launcher-"))
    try {
      await Promise.all([
        symlink(nodePath, join(tempDir, "node")),
        symlink(shPath, join(tempDir, "sh")),
        symlink(dirnamePath, join(tempDir, "dirname")),
      ])
      const nodeFallback = Bun.spawn({
        cmd: [launcherPath, "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await nodeFallback.exited).toBe(0)
      expect(await new Response(nodeFallback.stdout).text()).toBe("sixb agent CLI 1\n")
      expect(await new Response(nodeFallback.stderr).text()).toBe("")

      await rm(join(tempDir, "node"))
      const unavailable = Bun.spawn({
        cmd: [launcherPath, "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await unavailable.exited).toBe(2)
      expect(await new Response(unavailable.stdout).text()).toBe("")
      expect(JSON.parse(await new Response(unavailable.stderr).text())).toEqual({
        error: {
          code: "runtime_unavailable",
          message: "The Sixb CLI requires Bun or Node.js.",
        },
      })

      await symlink(launcherPath, join(tempDir, "sixb"))
      const missingArtifact = Bun.spawn({
        cmd: [join(tempDir, "sixb"), "--version"],
        env: { PATH: tempDir },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(await missingArtifact.exited).toBe(2)
      expect(await new Response(missingArtifact.stdout).text()).toBe("")
      expect(JSON.parse(await new Response(missingArtifact.stderr).text())).toEqual({
        error: {
          code: "runtime_unavailable",
          message: "The Sixb CLI artifact is missing.",
        },
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
