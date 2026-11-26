import { afterEach, expect, jest, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { DEV_STARTUP_TIMEOUT_MS, startupDeadline } from "../src/lib/dev-supervisor"

const supervisor = resolve(import.meta.dir, "../src/lib/dev-supervisor.ts")

afterEach(() => {
  jest.useRealTimers()
})

// A copy of millions of objects loads for minutes: killed at the minute, the next start loads it
// again and is killed again, forever. Guard check: drop the `loading` cases from
// `startupDeadline.observe` (`lib/dev-supervisor.ts`): the deadline fires mid-load.
test("waits while a branch's copy loads, and gives the rest of the startup its own minute", () => {
  jest.useFakeTimers()
  let expired = 0
  const deadline = startupDeadline(() => {
    expired += 1
  })

  jest.advanceTimersByTime(DEV_STARTUP_TIMEOUT_MS - 1_000)
  deadline.observe({ type: "loading", done: false })
  jest.advanceTimersByTime(10 * DEV_STARTUP_TIMEOUT_MS)
  expect(expired).toBe(0)

  deadline.observe({ type: "loading", done: true })
  jest.advanceTimersByTime(DEV_STARTUP_TIMEOUT_MS - 1)
  expect(expired).toBe(0)
  jest.advanceTimersByTime(1)
  expect(expired).toBe(1)
})

test("stops counting once the dev process is ready", () => {
  jest.useFakeTimers()
  let expired = 0
  const deadline = startupDeadline(() => {
    expired += 1
  })

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
