import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The guard is the thing that has to work when nothing else does, so it is exercised end to end
 * as a process rather than by calling its internals: a real child, real pipes, real signals.
 *
 * Every case waits on the guard's own clock — a one-second progress poll and a half-second
 * SIGTERM grace — so the cases run concurrently rather than adding those waits up.
 */
const guardPath = join(import.meta.dir, "..", "ci-guard.ts")

/**
 * Intentional stall fixtures still need their own last-resort bound. By default they also stop
 * when their parent goes away, so a harness SIGKILL cannot leave them waiting for that bound after
 * the guard disappears. The cleanup cases watch this test process instead: there, a fixture that
 * outlives the guard is exactly the failure under test.
 */
function boundedFixture(
  body = "",
  options: { readonly delayMs?: number; readonly watchTestProcess?: boolean } = {}
): string {
  const delayMs = options.delayMs ?? 100
  const iterations = Math.ceil(60_000 / delayMs)
  const step = body ? `${body}; ` : ""
  const watching = options.watchTestProcess
    ? `(() => { try { process.kill(${process.pid}, 0); return true } catch { return false } })()`
    : "process.ppid === fixtureParentPid"
  return [
    "const fixtureParentPid = process.ppid",
    `for (let i = 0; i < ${iterations} && ${watching}; i++) { ${step}await Bun.sleep(${delayMs}) }`,
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

/** Polls a reaped process away; a zombie still answers signal 0 until its parent collects it. */
async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const deadline = performance.now() + withinMs
  while (isProcessAlive(pid) && performance.now() < deadline) await Bun.sleep(10)
  return !isProcessAlive(pid)
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 200 && !(await Bun.file(path).exists()); attempt++) {
    await Bun.sleep(10)
  }
  const pid = Number(await Bun.file(path).text())
  expect(Number.isInteger(pid)).toBeTrue()
  return pid
}

function killQuietly(pid: number | null | undefined): void {
  if (pid === null || pid === undefined) return
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Already stopped.
  }
}

describe("ci-guard", () => {
  test.concurrent("passes a command's output and exit code straight through", async () => {
    const result = await runGuard([
      "--stall",
      "30",
      "--",
      process.execPath,
      "-e",
      'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exitCode = 3',
    ])

    expect(result.exitCode).toBe(3)
    expect(result.stdout).toContain("out")
    expect(result.stderr).toContain("err")
  })

  test.concurrent("kills a silent command and names the test file it was still running", async () => {
    // Mirrors the real failure: output flows, a test file reports, then the process goes quiet
    // past the guard's bound. Under `--parallel` the file that reported last had finished; bun
    // names the stuck one when SIGTERM interrupts it, as this fixture does. The fixture itself is
    // capped so an infrastructure failure cannot leak it.
    const result = await runGuard([
      "--stall",
      "0.5",
      "--",
      process.execPath,
      "-e",
      [
        'process.stderr.write("(pass) something\\n")',
        'process.stderr.write("::group::packages/app/tests/manifest.test.ts:\\n")',
        'process.on("SIGTERM", () => { process.stderr.write("Interrupted while still running:\\n  packages/cli/tests/lake.test.ts (61s)\\n"); process.exit(143) })',
        // A timer creates the required silence without making a leaked Bun fixture busy-spin.
        boundedFixture(),
      ].join("; "),
    ])

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toMatch(
      /::error title=CI guard: stalled::no output for [^\n]* — still running: packages\/cli\/tests\/lake\.test\.ts\n/
    )
    expect(result.stderr).toContain("last test file:  packages/app/tests/manifest.test.ts")
    // The tail is what turns "it hung" into "it hung here".
    expect(result.stderr).toContain("(pass) something")
    expect(result.stderr).toContain("-- process tree ---")
    // Killing the tree deliberately waits out a SIGTERM grace period, so every stall case needs
    // more than bun's 5s default per-test bound.
  }, 30_000)

  test.concurrent("bounds a command that keeps printing past the maximum", async () => {
    // A stall bound alone cannot catch a loop that stays chatty, so `--max` covers wall clock.
    // The fixture has its own generous cap so a broken guard still cannot leave it behind.
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

  test.concurrent("kills the whole process group when process listing is unavailable", async () => {
    // The orphaned `bun` processes the runner had to reap came from exactly this gap: a
    // restricted process sandbox denied `ps -A`, so the old implementation discovered an empty
    // tree and signaled nothing. Reverting the process-group cleanup leaves the grandchild
    // running, and this test fails.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-"))
    const pidPath = join(scriptDir, "grandchild-pid")
    const childPath = join(scriptDir, "child.ts")
    const parentPath = join(scriptDir, "parent.ts")
    let grandchildPid: number | null = null

    try {
      // A link, not a script: macOS vets a freshly written executable on its first run.
      await symlink(Bun.which("false") ?? "/usr/bin/false", join(scriptDir, "ps"))
      await writeFile(
        childPath,
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))\n${boundedFixture("", { watchTestProcess: true })}\n`
      )
      await writeFile(
        parentPath,
        [
          `Bun.spawn([process.execPath, ${JSON.stringify(childPath)}], { stdout: "ignore", stderr: "ignore" })`,
          `for (let i = 0; i < 500 && !(await Bun.file(${JSON.stringify(pidPath)}).exists()); i++) await Bun.sleep(10)`,
          'process.stdout.write("spawned\\n")',
          boundedFixture(),
        ].join("\n")
      )

      const result = await runGuard(["--stall", "0.5", "--", process.execPath, parentPath], {
        ...process.env,
        PATH: scriptDir,
      })
      expect(result.exitCode).toBe(124)

      grandchildPid = await readPid(pidPath)
      expect(await waitForExit(grandchildPid, 2_000)).toBeTrue()
    } finally {
      killQuietly(grandchildPid)
      await rm(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  test.concurrent("stops the guarded process before relaying a termination signal", async () => {
    // Local coding harnesses terminate their direct command on cancellation. The guard has to
    // reap its own child before it accepts that signal or the fixture is reparented to PID 1.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-signal-"))
    const pidPath = join(scriptDir, "child-pid")
    const childPath = join(scriptDir, "child.ts")
    let childPid: number | null = null
    let guard: Bun.Subprocess<"ignore", "ignore", "ignore"> | null = null

    try {
      await writeFile(
        childPath,
        `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid))\n${boundedFixture("", { watchTestProcess: true })}\n`
      )
      // A stuck diagnostic must not delay the process-group signal until after the caller's
      // grace: this `ps` holds the guard's process listing until its 2s bound.
      await writeFile(join(scriptDir, "ps"), "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 })
      guard = Bun.spawn(
        [process.execPath, guardPath, "--stall", "30", "--", process.execPath, childPath],
        {
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, PATH: scriptDir },
        }
      )
      childPid = await readPid(pidPath)

      guard.kill("SIGTERM")
      // Well inside the listing's 2s bound, so the child cannot have waited for it.
      expect(await waitForExit(childPid, 1_000)).toBeTrue()
      await guard.exited
      expect(guard.signalCode).toBe("SIGTERM")
    } finally {
      killQuietly(guard?.pid)
      killQuietly(childPid)
      await rm(scriptDir, { recursive: true, force: true })
    }
  }, 30_000)

  test.concurrent("refuses arguments it cannot act on rather than guessing", async () => {
    const noStall = await runGuard(["--", process.execPath, "-e", ""])
    expect(noStall.exitCode).toBe(2)
    expect(noStall.stderr).toContain("--stall <seconds> is required")

    expect((await runGuard(["--stall", "5"])).stderr).toContain("Expected a command to run")
    expect((await runGuard(["--stall", "nope", "--", "true"])).stderr).toContain(
      "needs a positive number of seconds"
    )
  })
})
