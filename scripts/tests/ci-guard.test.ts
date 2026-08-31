import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The guard is the thing that has to work when nothing else does, so it is exercised end to end
 * as a process rather than by calling its internals: a real child, real pipes, real signals.
 */
const guardPath = join(import.meta.dir, "..", "ci-guard.ts")

/**
 * Intentional stall fixtures still need their own last-resort bound. They also watch their parent
 * so a harness SIGKILL cannot leave them waiting for that bound after the guard disappears.
 */
function boundedFixture(body = "", delayMs = 100): string {
  const iterations = Math.ceil(60_000 / delayMs)
  const step = body ? `${body}; ` : ""
  return [
    "const fixtureParentPid = process.ppid",
    `for (let i = 0; i < ${iterations} && process.ppid === fixtureParentPid; i++) { ${step}await Bun.sleep(${delayMs}) }`,
  ].join("; ")
}

async function runGuard(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, guardPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode: await proc.exited, stdout, stderr }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("ci-guard", () => {
  test("passes a healthy command's output and exit code straight through", async () => {
    const result = await runGuard([
      "--stall",
      "30",
      "--",
      process.execPath,
      "-e",
      'process.stdout.write("out\\n"); process.stderr.write("err\\n")',
    ])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("out")
    expect(result.stderr).toContain("err")
  })

  test("preserves a failing command's exit code instead of masking it", async () => {
    const result = await runGuard([
      "--stall",
      "30",
      "--",
      process.execPath,
      "-e",
      "process.exit(3)",
    ])

    expect(result.exitCode).toBe(3)
  })

  test("kills a silent command and names the last test file it saw", async () => {
    // Mirrors the real failure: output flows, a test file opens, then the process goes quiet past
    // the guard's bound. The fixture itself is capped so an infrastructure failure cannot leak it.
    const result = await runGuard([
      "--stall",
      "1",
      "--",
      process.execPath,
      "-e",
      [
        'process.stderr.write("(pass) something\\n")',
        'process.stderr.write("::group::packages/atlas/tests/atlas-app.test.ts:\\n")',
        // A timer creates the required silence without making a leaked Bun fixture busy-spin.
        boundedFixture(),
      ].join("; "),
    ])

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("::error title=CI guard: stalled::")
    expect(result.stderr).toContain("packages/atlas/tests/atlas-app.test.ts")
    expect(result.stderr).toContain("no output for")
    // The tail is what turns "it hung" into "it hung here".
    expect(result.stderr).toContain("(pass) something")
    expect(result.stderr).toContain("-- process tree ---")
    // Killing the tree deliberately waits out a SIGTERM grace period, so every stall case needs
    // more than bun's 5s default per-test bound.
  }, 30_000)

  test("bounds a command that keeps printing past the maximum", async () => {
    // A stall bound alone cannot catch a loop that stays chatty, so `--max` covers wall clock. The
    // fixture has its own generous cap so a broken guard still cannot leave it behind indefinitely.
    const result = await runGuard([
      "--stall",
      "30",
      "--max",
      "1",
      "--",
      process.execPath,
      "-e",
      boundedFixture('process.stdout.write("still here\\n")'),
    ])

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("ran for")
  }, 30_000)

  test("kills the whole process group when process listing is unavailable", async () => {
    // The orphaned `bun` processes the runner had to reap came from exactly this gap: a restricted
    // process sandbox denied `ps -A`, so the old implementation discovered an empty tree and
    // signaled nothing. Reverting the process-group cleanup makes this test time out and leak.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-"))
    const markerPath = join(scriptDir, "child-alive")
    const childPath = join(scriptDir, "child.ts")
    const parentPath = join(scriptDir, "parent.ts")
    const fakePsPath = join(scriptDir, "ps")

    try {
      await writeFile(fakePsPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      await writeFile(
        childPath,
        boundedFixture(`await Bun.write(${JSON.stringify(markerPath)}, String(Date.now()))`, 50)
      )
      await writeFile(
        parentPath,
        [
          `Bun.spawn([process.execPath, ${JSON.stringify(childPath)}], { stdout: "ignore", stderr: "ignore" })`,
          'process.stdout.write("spawned\\n")',
          boundedFixture(),
        ].join("\n")
      )

      const result = await runGuard(["--stall", "1", "--", process.execPath, parentPath], {
        ...process.env,
        PATH: scriptDir,
      })
      expect(result.exitCode).toBe(124)

      // The grandchild keeps stamping the marker while it lives, so a marker that stops moving is
      // proof it was killed rather than reparented.
      const afterKill = await Bun.file(markerPath).text()
      await Bun.sleep(500)
      expect(await Bun.file(markerPath).text()).toBe(afterKill)
    } finally {
      await rm(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("stops the guarded process before relaying a termination signal", async () => {
    // Local coding harnesses terminate their direct command on cancellation. The guard has to reap
    // its own child before it accepts that signal or the fixture is reparented to PID 1.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-signal-"))
    const pidPath = join(scriptDir, "child-pid")
    const childPath = join(scriptDir, "child.ts")
    const fakePsPath = join(scriptDir, "ps")
    let childPid: number | null = null
    let guard: Bun.Subprocess<"ignore", "ignore", "ignore"> | null = null

    try {
      await writeFile(
        childPath,
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))\n${boundedFixture()}\n`
      )
      // A stuck diagnostic must not delay the process-group signal until after the caller's grace.
      await writeFile(fakePsPath, "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 })
      guard = Bun.spawn(
        [process.execPath, guardPath, "--stall", "30", "--", process.execPath, childPath],
        {
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, PATH: scriptDir },
        }
      )

      for (let attempt = 0; attempt < 100 && !(await Bun.file(pidPath).exists()); attempt++) {
        await Bun.sleep(10)
      }
      childPid = Number(await Bun.file(pidPath).text())
      expect(Number.isInteger(childPid)).toBeTrue()

      guard.kill("SIGTERM")
      await guard.exited
      await Bun.sleep(100)
      expect(isProcessAlive(childPid)).toBeFalse()
    } finally {
      try {
        guard?.kill("SIGKILL")
      } catch {
        // Already stopped.
      }
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL")
        } catch {
          // The assertion path already proved it was stopped.
        }
      }
      await rm(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("bounds a fixture even when the guard is killed without cleanup", async () => {
    // SIGKILL cannot be handled. The fixture itself watches its parent so the exact failure mode
    // that produced the local PID-1 orphans still converges without waiting for its wall-clock cap.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-sigkill-"))
    const pidPath = join(scriptDir, "child-pid")
    const childPath = join(scriptDir, "child.ts")
    let childPid: number | null = null
    let guard: Bun.Subprocess<"ignore", "ignore", "ignore"> | null = null

    try {
      await writeFile(
        childPath,
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))\n${boundedFixture()}\n`
      )
      guard = Bun.spawn(
        [process.execPath, guardPath, "--stall", "30", "--", process.execPath, childPath],
        { stdout: "ignore", stderr: "ignore" }
      )

      for (let attempt = 0; attempt < 100 && !(await Bun.file(pidPath).exists()); attempt++) {
        await Bun.sleep(10)
      }
      childPid = Number(await Bun.file(pidPath).text())
      expect(Number.isInteger(childPid)).toBeTrue()

      guard.kill("SIGKILL")
      await guard.exited
      for (let attempt = 0; attempt < 100 && isProcessAlive(childPid); attempt++) {
        await Bun.sleep(10)
      }
      expect(isProcessAlive(childPid)).toBeFalse()
    } finally {
      try {
        guard?.kill("SIGKILL")
      } catch {
        // Already stopped.
      }
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL")
        } catch {
          // Already stopped.
        }
      }
      await rm(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  test("refuses arguments it cannot act on rather than guessing", async () => {
    const noStall = await runGuard(["--", process.execPath, "-e", ""])
    expect(noStall.exitCode).toBe(2)
    expect(noStall.stderr).toContain("--stall <seconds> is required")

    expect((await runGuard(["--stall", "5"])).stderr).toContain("Expected a command to run")
    expect((await runGuard(["--stall", "nope", "--", "true"])).stderr).toContain(
      "needs a positive number of seconds"
    )
  })
})
