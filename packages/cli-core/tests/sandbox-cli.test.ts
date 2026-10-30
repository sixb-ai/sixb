import { describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type CliResult,
  runSandboxCliContractSuite,
  runSandboxCliProcessSmoke,
} from "./sandbox-cli-contract"

const launcherPath = resolve(import.meta.dir, "..", "src", "bin", "sixb")
const artifactPath = resolve(import.meta.dir, "..", "src", "generated", "sixb.mjs")
const GENERATOR_CHECK_TIMEOUT_MS = 10_000
const VERSION = "sixb CLI 1"

runSandboxCliContractSuite({
  name: "generated artifact",
  version: VERSION,
  runtime: "bun",
  run: runArtifactInProcess,
})

describe("Sixb sandbox CLI generated artifact process boundary", () => {
  runSandboxCliProcessSmoke({
    runtime: "bun",
    command: [process.execPath, artifactPath],
    version: VERSION,
  })
  runSandboxCliProcessSmoke({ runtime: "node", command: ["node", artifactPath], version: VERSION })
  // A sandbox that adds the run token outside its commands gives them a `unix:` address.
  runSandboxCliProcessSmoke({
    runtime: "bun",
    command: [process.execPath, artifactPath],
    version: VERSION,
    overUnixSocket: true,
  })
  runSandboxCliProcessSmoke({
    runtime: "node",
    command: ["node", artifactPath],
    version: VERSION,
    overUnixSocket: true,
  })
})

let invocation = 0

/**
 * Runs the generated artifact in this process as `bun sixb.mjs <args>` would: each call imports a
 * fresh module instance, whose top level reads argv and env, writes stdout and stderr, and sets
 * the exit code. Calls must not overlap.
 */
async function runArtifactInProcess(
  args: readonly string[],
  env: Readonly<Record<string, string>>
): Promise<CliResult> {
  const stdout: string[] = []
  const stderr: string[] = []
  const capture = (into: string[]) => (chunk: string | Uint8Array) => {
    into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  const argv = process.argv
  const exitCode = process.exitCode
  const previousEnv = Object.keys(env).map((key) => [key, process.env[key]] as const)
  const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(capture(stdout))
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation(capture(stderr))
  process.argv = [process.execPath, artifactPath, ...args]
  process.exitCode = 0
  Object.assign(process.env, env)
  try {
    invocation += 1
    await import(`${artifactPath}?invocation=${invocation}`)
    return { exitCode: Number(process.exitCode), stdout: stdout.join(""), stderr: stderr.join("") }
  } finally {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.argv = argv
    process.exitCode = exitCode
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("Sixb sandbox CLI generated artifact", () => {
  test(
    "is current and has no workspace or third-party runtime imports",
    async () => {
      const check = Bun.spawn({
        cmd: [process.execPath, "./scripts/generate-sandbox-cli.ts", "--check"],
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      let timedOut = false
      const killTimer = setTimeout(() => {
        timedOut = true
        check.kill("SIGKILL")
      }, GENERATOR_CHECK_TIMEOUT_MS)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          check.exited,
          new Response(check.stdout).text(),
          new Response(check.stderr).text(),
        ])
        if (timedOut) {
          throw new Error(
            `Sandbox CLI generation exceeded ${GENERATOR_CHECK_TIMEOUT_MS}ms and was killed.`
          )
        }
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
        expect(stdout).toContain("Generated CLI is current")

        const artifact = await readFile(artifactPath, "utf8")
        expect(artifact).not.toMatch(/from\s+["']@sixb\//)
        expect(artifact).not.toMatch(/from\s+["']ai(?:\/|["'])/)
        expect(artifact).not.toContain("curl")
        expect(artifact).not.toContain("jq")
        expect(Buffer.byteLength(artifact)).toBeLessThan(200_000)
      } finally {
        clearTimeout(killTimer)
      }
    },
    GENERATOR_CHECK_TIMEOUT_MS + 5_000
  )

  test("launcher falls back to Node and reports a stable error when neither runtime exists", async () => {
    const nodePath = Bun.which("node")
    const shPath = Bun.which("sh")
    const dirnamePath = Bun.which("dirname")
    if (!nodePath || !shPath || !dirnamePath) throw new Error("Expected host runtime tools.")
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sandbox-cli-launcher-"))
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
      expect(await new Response(nodeFallback.stdout).text()).toBe("sixb CLI 1\n")
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
