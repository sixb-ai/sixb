import { describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
        cmd: [process.execPath, "./scripts/generate-cli.ts", "--check"],
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

describe("Sixb CLI project delegation (Option B)", () => {
  const LAUNCH_TIMEOUT_MS = 5_000

  // Guard proof: drop `findProjectCli` delegation from src/main.ts; `dev`, `env`, and `check`
  // stop reaching `node_modules/.bin/sixb-project`.
  test("delegates project commands in JS to sixb-project and keeps API commands in sixb", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-project-"))
    try {
      const projectBin = join(tempDir, "project", "node_modules", ".bin")
      await mkdir(projectBin, { recursive: true })
      await mkdir(join(tempDir, "project", "app"), { recursive: true })
      await mkdir(join(tempDir, "elsewhere"), { recursive: true })
      await writeFile(
        join(projectBin, "sixb-project"),
        "#!/bin/sh\nprintf '%s\\n' project \"$@\"\n"
      )
      await chmod(join(projectBin, "sixb-project"), 0o755)

      const run = (cwd: string, args: readonly string[]) =>
        launch(launcherPath, join(tempDir, cwd), args)

      // API and auth commands stay in `sixb` even inside a Sixb project.
      for (const args of [
        ["--help"],
        ["--version"],
        ["project", "--help"],
        ["objects", "--help"],
        ["tokens", "--help"],
        ["login", "--help"],
        ["api", "--help"],
      ]) {
        const res = await run("project/app", args)
        expect(res.exitCode, res.stderr).toBe(0)
        expect(res.stdout).not.toStartWith("project\n")
      }

      // Project commands walk up from a subdirectory and hand args unchanged to `sixb-project`.
      expect((await run("project/app", ["dev"])).stdout.trimEnd().split("\n")).toEqual([
        "project",
        "dev",
      ])
      expect(
        (await run("project/app", ["env", "set", "NAME", "a b"])).stdout.trimEnd().split("\n")
      ).toEqual(["project", "env", "set", "NAME", "a b"])
      expect((await run("project", ["check"])).stdout.trimEnd().split("\n")).toEqual([
        "project",
        "check",
      ])

      // Outside a project (with no sixb-project on PATH), project commands report a clear error.
      const missing = await launch(launcherPath, join(tempDir, "elsewhere"), ["dev"], {
        PATH: "/usr/bin:/bin",
      })
      expect(missing.exitCode).toBe(2)
      expect(JSON.parse(missing.stderr).error.code).toBe("runtime_unavailable")
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  async function launch(
    launcher: string,
    cwd: string,
    args: readonly string[],
    envOverride?: Readonly<Record<string, string>>
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
    const bunDir = dirname(process.execPath)
    const basePath = envOverride?.PATH ? `${bunDir}:${envOverride.PATH}` : (process.env.PATH ?? "")
    const child = Bun.spawn({
      cmd: [launcher, ...args],
      cwd,
      env: { PATH: basePath },
      stdout: "pipe",
      stderr: "pipe",
    })
    const killTimer = setTimeout(() => child.kill("SIGKILL"), LAUNCH_TIMEOUT_MS)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(killTimer)
    }
  }
})
