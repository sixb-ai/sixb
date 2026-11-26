import { afterEach, expect, jest, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { COPY_LOAD_REPORT_EVERY_MS, trackCopyLoad } from "../src/lib/branch-from-production"
import type { DevChildMessage } from "../src/lib/dev-messages"
import {
  DEV_LOAD_STALL_MS,
  DEV_STARTUP_TIMEOUT_MS,
  startupDeadline,
} from "../src/lib/dev-supervisor"

const supervisor = resolve(import.meta.dir, "../src/lib/dev-supervisor.ts")

afterEach(() => {
  jest.useRealTimers()
})

// A copy of millions of objects loads for minutes: killed at the minute, the next start loads it
// again and is killed again, forever. Guard check: drop the `loading` handling from
// `startupDeadline.observe` (`lib/dev-supervisor.ts`): the deadline fires mid-load.
test("waits while a branch's copy loads and makes progress, then gives the rest its own minute", () => {
  jest.useFakeTimers()
  const expired: string[] = []
  const deadline = startupDeadline((timeout) => expired.push(timeout.message))

  jest.advanceTimersByTime(DEV_STARTUP_TIMEOUT_MS - 1_000)
  for (let bytesRead = 0; bytesRead <= 10; bytesRead += 1) {
    deadline.observe(loading(bytesRead, 100))
    jest.advanceTimersByTime(DEV_LOAD_STALL_MS - 1_000)
  }
  // Read whole, it indexes: each report that it is still at work counts as progress.
  for (let tick = 0; tick < 3; tick += 1) {
    deadline.observe(loading(100, 100))
    jest.advanceTimersByTime(DEV_LOAD_STALL_MS - 1_000)
  }
  expect(expired).toEqual([])

  deadline.observe(loading(100, 100, true))
  jest.advanceTimersByTime(DEV_STARTUP_TIMEOUT_MS - 1)
  expect(expired).toEqual([])
  jest.advanceTimersByTime(1)
  expect(expired).toEqual(["Startup timed out."])
})

// A load that hangs would hold `sixb dev` for good. Guard check: in `startupDeadline.observe`,
// arm the stall deadline on every report, or clear the deadline instead: the hung load never fails.
test("stops a load that reads nothing further for the stall window", () => {
  jest.useFakeTimers()
  const expired: string[] = []
  const deadline = startupDeadline((timeout) => expired.push(timeout.message))

  deadline.observe(loading(0, 100))
  deadline.observe(loading(40, 100))
  for (let tick = 0; tick < 30; tick += 1) {
    jest.advanceTimersByTime(10_000)
    deadline.observe(loading(40, 100))
  }

  expect(expired).toEqual(["Loading this branch's copy made no progress for 5 minutes."])
})

// Guard check: in `trackCopyLoad` (`lib/branch-from-production.ts`), drop the interval: a copy
// that loads for minutes says nothing between its first line and its last.
test("a loading copy reports when it starts, every few seconds with what it read, and once done", () => {
  jest.useFakeTimers()
  const reports: [boolean, number][] = []
  const load = trackCopyLoad(1_000, (done, progress) => reports.push([done, progress.bytesRead]))

  load.read(300)
  jest.advanceTimersByTime(COPY_LOAD_REPORT_EVERY_MS)
  load.read(700)
  jest.advanceTimersByTime(COPY_LOAD_REPORT_EVERY_MS)
  load.done()
  jest.advanceTimersByTime(3 * COPY_LOAD_REPORT_EVERY_MS)

  expect(reports).toEqual([
    [false, 0],
    [false, 300],
    [false, 1_000],
    [true, 1_000],
  ])
})

test("stops counting once the dev process is ready", () => {
  jest.useFakeTimers()
  let expired = 0
  const deadline = startupDeadline(() => {
    expired += 1
  })

  deadline.observe(loading(0, 100))
  deadline.observe({ type: "ready", watchesApp: false, app: null })
  jest.advanceTimersByTime(2 * DEV_STARTUP_TIMEOUT_MS)

  expect(expired).toBe(0)
})

// Guard check: remove process.execArgv from the spawn arguments in dev-supervisor.ts.
// The child then reports null instead of the global initialized by the preload.
test.concurrent.each([
  { runtimeArgs: ["--preload", "./preload.ts"] },
  { runtimeArgs: ["--preload=./preload.ts"] },
])("dev child preserves runtime options: %j", async ({ runtimeArgs }) => {
  const root = await mkdtemp(join(tmpdir(), "sixb-dev-supervisor-"))
  try {
    await writeFile(join(root, "preload.ts"), 'globalThis.preloaded = "initialized"\n')
    await writeFile(join(root, "sixb.config.ts"), "export default globalThis.preloaded ?? null\n")
    await writeFile(
      join(root, "entry.ts"),
      `
import { runDevSupervisor } from ${JSON.stringify(supervisor)}
if (process.env.SIXB_DEV_CHILD === "1") {
  const { default: value } = await import("./sixb.config.ts")
  console.log(JSON.stringify({ value, args: process.argv.slice(2) }))
  process.kill(process.ppid, "SIGTERM")
  process.exit(0)
} else {
  await runDevSupervisor({ entry: "./sixb.config.ts" })
}
`
    )
    const proc = Bun.spawn(
      [process.execPath, ...runtimeArgs, join(root, "entry.ts"), "dev", "--port", "4321"],
      {
        cwd: root,
        env: { ...process.env, SIXB_DEV_CHILD: "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      }
    )
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout).toContain(
      JSON.stringify({ value: "initialized", args: ["dev", "--port", "4321"] })
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)

function loading(bytesRead: number, bytes: number, done = false): DevChildMessage {
  return { type: "loading", done, progress: { bytesRead, bytes, elapsedMs: 0 } }
}
