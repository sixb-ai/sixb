import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The guard is the thing that has to work when nothing else does, so it is exercised end to end
 * as a process rather than by calling its internals: a real child, real pipes, real signals.
 */
const guardPath = join(import.meta.dir, "..", "ci-guard.ts")

async function runGuard(
  args: readonly string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, guardPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { exitCode: await proc.exited, stdout, stderr }
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
    // Mirrors the real failure: output flows, a test file opens, then the process goes quiet
    // forever. Without the guard this is the run that dies at the job's wall clock instead.
    const result = await runGuard([
      "--stall",
      "1",
      "--",
      process.execPath,
      "-e",
      [
        'process.stderr.write("(pass) something\\n")',
        'process.stderr.write("::group::packages/atlas/tests/atlas-app.test.ts:\\n")',
        "await new Promise(() => {})",
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

  test("bounds a command that keeps printing but never finishes", async () => {
    // A stall bound alone cannot catch a loop that stays chatty, so `--max` covers wall clock.
    const result = await runGuard([
      "--stall",
      "30",
      "--max",
      "1",
      "--",
      process.execPath,
      "-e",
      'setInterval(() => process.stdout.write("still here\\n"), 100)',
    ])

    expect(result.exitCode).toBe(124)
    expect(result.stderr).toContain("ran for")
  }, 30_000)

  test("kills the whole tree so no child outlives the guard", async () => {
    // The orphaned `bun` processes the runner had to reap came from exactly this gap: killing the
    // command without killing what it spawned.
    const scriptDir = await mkdtemp(join(tmpdir(), "sixb-ci-guard-"))
    const markerPath = join(scriptDir, "child-alive")
    const childPath = join(scriptDir, "child.ts")
    const parentPath = join(scriptDir, "parent.ts")

    try {
      await writeFile(
        childPath,
        [
          `setInterval(() => { Bun.write(${JSON.stringify(markerPath)}, String(Date.now())) }, 50)`,
          "await new Promise(() => {})",
        ].join("\n")
      )
      await writeFile(
        parentPath,
        [
          `Bun.spawn([process.execPath, ${JSON.stringify(childPath)}], { stdout: "ignore", stderr: "ignore" })`,
          'process.stdout.write("spawned\\n")',
          "await new Promise(() => {})",
        ].join("\n")
      )

      const result = await runGuard(["--stall", "1", "--", process.execPath, parentPath])
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
