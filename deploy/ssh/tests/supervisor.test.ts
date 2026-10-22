import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DeployStatus } from "@sixb/core/deploy"
import { renderProcessLogLine } from "../src/server/logs"
import type { ProcessManifest } from "../src/server/manifest"

const helper = resolve(import.meta.dir, "../src/server/cli.ts")
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startSupervisor(preload?: string): Promise<{ manifestPath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "sixb-supervisor-"))
  const manifest: ProcessManifest = {
    version: 1,
    name: "northline",
    cwd: root,
    runDir: join(root, "run"),
    logDir: join(root, "run", "logs"),
    releasePath: join(root, "release.json"),
    services: [
      {
        name: "api",
        processName: "northline-api",
        command: process.execPath,
        // Printed on an interval: Bun may hold a single write to a pipe in its buffer. It exits
        // once orphaned, because cleanup kills the supervisor rather than waiting on its shutdown.
        args: [
          "-e",
          'const parent = process.ppid; setInterval(() => { if (process.ppid !== parent) process.exit(); console.log("listening") }, 100)',
        ],
        env: {},
        instances: 1,
        killTimeoutMs: 2_000,
        restartDelayMs: 100,
      },
      {
        name: "workers",
        processName: "northline-workers",
        command: process.execPath,
        args: ["-e", 'console.error("boom"); process.exit(1)'],
        env: {},
        instances: 2,
        killTimeoutMs: 2_000,
        restartDelayMs: 100,
      },
    ],
  }
  const manifestPath = join(root, "processes.json")
  await writeFile(manifestPath, JSON.stringify(manifest))
  await writeFile(
    manifest.releasePath,
    JSON.stringify({
      commit: "abc123",
      ref: "main",
      deployedAt: "2026-09-30T12:00:00.000Z",
      deployedBy: "ci",
    })
  )

  const supervisor = Bun.spawn(
    [
      process.execPath,
      ...(preload ? ["--preload", resolve(import.meta.dir, "fixtures", preload)] : []),
      helper,
      "supervise",
      "--manifest",
      manifestPath,
    ],
    {
      stdout: "ignore",
      stderr: "ignore",
    }
  )
  cleanups.push(async () => {
    // Not SIGTERM: shutdown waits killTimeoutMs plus 2s for a restarting worker whose exit Bun
    // never reports, and no test here is about shutdown.
    supervisor.kill("SIGKILL")
    await supervisor.exited
    await rm(root, { recursive: true, force: true })
  })
  return { manifestPath, root }
}

async function ctl(manifestPath: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, helper, ...args, "--manifest", manifestPath], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function status(manifestPath: string): Promise<DeployStatus> {
  return JSON.parse((await ctl(manifestPath, "status", "--json")).stdout) as DeployStatus
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read().catch(() => undefined)
    if (value !== undefined && done(value)) return value
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for the supervisor.")
}

describe("supervisor", () => {
  test("runs every instance, restarts what exits, logs its output, and reports the release", async () => {
    const { manifestPath } = await startSupervisor()

    // The count rises before the restart is scheduled, so only a second exit proves a restarted
    // instance ran. Removal proof: empty the restart timer in the supervisor's `handleExit`.
    const report = await until(
      () => status(manifestPath),
      (value) => value.processes.some((entry) => entry.service === "workers" && entry.restarts > 1)
    )
    expect(report.running).toBe(true)
    expect(report.release?.commit).toBe("abc123")
    expect(report.processes.map((entry) => `${entry.service}#${entry.instance}`)).toEqual([
      "api#0",
      "workers#0",
      "workers#1",
    ])
    expect(report.processes[0]?.status).toBe("running")

    const check = await ctl(manifestPath, "status", "--check")
    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain("workers")
    expect(check.stderr).not.toContain("api")

    const logs = await until(
      () => ctl(manifestPath, "logs", "api"),
      (value) => value.stdout.includes("listening")
    )
    expect(logs.stdout).toMatch(/^\d\d:\d\d:\d\d api {1}listening$/m)
  })

  test("stops, starts, and restarts one service on request", async () => {
    const { manifestPath } = await startSupervisor()
    await until(
      () => status(manifestPath),
      (value) => value.processes[0]?.status === "running"
    )

    expect((await ctl(manifestPath, "stop", "api")).stdout).toContain("stopped api")
    expect((await status(manifestPath)).processes[0]?.status).toBe("stopped")

    expect((await ctl(manifestPath, "start", "api")).exitCode).toBe(0)
    expect((await status(manifestPath)).processes[0]?.status).toBe("running")

    const unknown = await ctl(manifestPath, "restart", "sentinel")
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain("No service named 'sentinel'")
  })

  // Reproduce: remove the final awaited writeState() in stopManaged(). The stop response then
  // overtakes the held state write, leaving status at "stopping" after a successful command.
  test("publishes the stopped state before acknowledging stop", async () => {
    const { manifestPath, root } = await startSupervisor("hold-stopped-state.ts")
    await until(
      () => status(manifestPath),
      (value) => value.processes[0]?.status === "running"
    )

    let answered = false
    const stopped = ctl(manifestPath, "stop", "api").then((result) => {
      answered = true
      return result
    })
    try {
      await until(() => Bun.file(join(root, "run", "state-write-held")).exists(), Boolean)
      expect((await status(manifestPath)).processes[0]?.status).toBe("stopping")
      // An early acknowledgment is written within milliseconds of the exit, then either still
      // waits in run/responses or has already been read by the client.
      await Bun.sleep(100)
      expect(await readdir(join(root, "run", "responses"))).toEqual([])
      expect(answered).toBe(false)
    } finally {
      await writeFile(join(root, "run", "release-state-write"), "")
      await stopped
    }

    expect((await stopped).exitCode).toBe(0)
    expect((await status(manifestPath)).processes[0]?.status).toBe("stopped")
  }, 10_000)

  // Reproduce: write the response with a plain writeFile in the supervisor's writeResponse(). The
  // empty file then sits at its final path while held, and the polling client fails to parse it.
  test("never shows a response before its content", async () => {
    const { manifestPath, root } = await startSupervisor("hold-response-write.ts")
    await until(
      () => status(manifestPath),
      (value) => value.running
    )

    const answered = ctl(manifestPath, "restart", "sentinel")
    try {
      await until(() => Bun.file(join(root, "run", "response-write-held")).exists(), Boolean)
      const visible = await readdir(join(root, "run", "responses"))
      expect(visible.filter((name) => name.endsWith(".json"))).toEqual([])
    } finally {
      await writeFile(join(root, "run", "release-response-write"), "")
    }

    const unknown = await answered
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain("No service named 'sentinel'")
  }, 10_000)
})

describe("log lines", () => {
  const path = "/home/sixb/northline/run/logs/northline-workers-0.log"
  const render = (line: string) =>
    renderProcessLogLine({ path, line }, { label: "workers", labelWidth: 8 })

  test("print compactly in local time", () => {
    const at = new Date(2026, 8, 30, 18, 13, 55).toISOString()
    expect(render(`[${at}] [stdout] sync running`)).toBe("18:13:55 workers  sync running")
    expect(render(`[${at}] [stderr] database failed`)).toBe(
      "18:13:55 workers  stderr database failed"
    )
    expect(render(`[${at}] start northline-workers#0 pid=20738`)).toBe(
      "18:13:55 workers  started pid=20738"
    )
    expect(render(`[${at}] exit code=1 signal=null`)).toBe("18:13:55 workers  exited code=1")
    expect(render(`[${at}] [stdout] `)).toBeNull()
    expect(render(`[${at}] [stdout] \x1B[2K\x1B[1A\x1B[2K\x1B[GSixb API started`)).toBe(
      "18:13:55 workers  Sixb API started"
    )
    expect(render(`[${at}] [stdout] \x1B[2K\x1B[1A`)).toBeNull()
  })
})
