import { afterEach, beforeEach, expect, jest, setSystemTime, test } from "bun:test"
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { holdRunFiles } from "../src/run-files-lock"

let root = ""
let directory = ""
const signal = new AbortController().signal

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-run-files-lock-")))
  directory = join(root, "agt_thr_1")
})

afterEach(() => {
  jest.useRealTimers()
  setSystemTime()
  rmSync(root, { recursive: true, force: true })
})

/** One turn of the real event loop, which fake timers leave alone: file I/O completes on it. */
function loopTurn(): Promise<void> {
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve) => {
    port1.onmessage = () => {
      port1.close()
      port2.close()
      resolve()
    }
    port2.postMessage(null)
  })
}

/** Turn the loop, `stepMs` of fake time each, until `done`, or fail after `steps`. */
async function until(done: () => boolean, stepMs: number, steps = 5_000): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    await loopTurn()
    if (done()) return
    jest.advanceTimersByTime(stepMs)
  }
  throw new Error("[test] It did not settle.")
}

function heldBy(runId: string, pid = process.pid): void {
  writeFileSync(`${directory}.lock`, JSON.stringify({ pid, runId }))
}

// Regression proof: resolve holdRunFiles without creating its lock; the next run of a thread then
// empties the directory while another sixb's release of the last run still removes it.
test("waits until a live run of another process gives the directory back", async () => {
  jest.useFakeTimers()
  heldBy("agt_run_other")
  const events: string[] = []

  const held = holdRunFiles({ directory, runId: "agt_run_next", signal }).then((release) => {
    events.push("next held")
    return release
  })
  // It polls while the other run releases.
  for (let step = 0; step < 10; step += 1) {
    await loopTurn()
    jest.advanceTimersByTime(100)
  }
  events.push("other released")
  rmSync(`${directory}.lock`)
  let release: (() => Promise<void>) | undefined
  void held.then((value) => {
    release = value
  })
  await until(() => release !== undefined, 100)

  expect(events).toEqual(["other released", "next held"])
  expect(JSON.parse(readFileSync(`${directory}.lock`, "utf8"))).toEqual({
    pid: process.pid,
    runId: "agt_run_next",
  })
  await release?.()
  expect(readdirSync(root)).toEqual([])
})

// Regression proof: count a gone process as alive in holdRunFiles; a lock a crashed sixb left
// holds the thread's directory until the takeover deadline.
test("takes over a lock whose process is gone", async () => {
  const exited = Bun.spawn(["true"])
  await exited.exited
  heldBy("agt_run_crashed", exited.pid)

  jest.useFakeTimers()
  let release: (() => Promise<void>) | undefined
  void holdRunFiles({ directory, runId: "agt_run_next", signal }).then((value) => {
    release = value
  })
  // No time passes: a gone holder is not waited for.
  await until(() => release !== undefined, 0)

  expect(JSON.parse(readFileSync(`${directory}.lock`, "utf8"))).toMatchObject({
    runId: "agt_run_next",
  })
  await release?.()
})

test("takes over a live holder that never gives it back, and says so", async () => {
  jest.useFakeTimers()
  heldBy("agt_run_stuck")
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    let release: (() => Promise<void>) | undefined
    void holdRunFiles({ directory, runId: "agt_run_next", signal }).then((value) => {
      release = value
    })
    // It waits for the live holder, then gives up on it past the deadline.
    for (let step = 0; step < 10; step += 1) {
      await loopTurn()
      jest.advanceTimersByTime(100)
    }
    expect(release).toBeUndefined()
    setSystemTime(new Date(Date.now() + 60_000))
    await until(() => release !== undefined, 100)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("from run 'agt_run_stuck'"))
    await release?.()
  } finally {
    warn.mockRestore()
  }
})

// Regression proof: remove the lock unconditionally in the release; a run taken over removes the
// lock of the run that took it.
test("gives back only a lock it still holds", async () => {
  jest.useFakeTimers()
  const release = await holdRunFiles({ directory, runId: "agt_run_slow", signal })
  heldBy("agt_run_next")

  await release()
  expect(JSON.parse(readFileSync(`${directory}.lock`, "utf8"))).toMatchObject({
    runId: "agt_run_next",
  })
})
