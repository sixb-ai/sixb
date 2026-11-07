import { afterEach, describe, expect, jest, test } from "bun:test"
import { DuckLakeReadGate, DuckLakeReadsBusy } from "../src/internal/ducklake-read-gate"

const WAIT_MS = 30_000
const DRAIN_MS = 5_000
const DRAIN_REST_MS = 5 * 60_000

afterEach(() => {
  jest.useRealTimers()
})

test("running maintenance excludes readers and other maintenance jobs", async () => {
  const gate = new DuckLakeReadGate()
  const controller = new AbortController()
  const finish = Promise.withResolvers<void>()
  const first = gate.withMaintenance(controller.signal, () => finish.promise)
  let readStarted = false
  const reader = gate.acquire(controller.signal).then((release) => {
    readStarted = true
    return release
  })
  let maintenanceStarted = false
  const second = gate.withMaintenance(controller.signal, async () => {
    maintenanceStarted = true
  })
  try {
    await Promise.resolve()
    // Red check: drop the maintenance flag from either admission condition. A reader or the
    // second maintenance job then enters while the first still owns the critical section.
    expect(readStarted).toBe(false)
    expect(maintenanceStarted).toBe(false)
    finish.resolve()
    await first
    const release = await reader
    expect(maintenanceStarted).toBe(false)
    release()
    release()
    await second
    expect(maintenanceStarted).toBe(true)
  } finally {
    controller.abort()
    finish.resolve()
    await Promise.allSettled([first, reader, second])
  }
})

test("cancels queued readers and reopens admission after maintenance fails", async () => {
  const gate = new DuckLakeReadGate()
  const controller = new AbortController()
  const finish = Promise.withResolvers<void>()
  const failed = new Error("maintenance failed")
  const maintenance = gate
    .withMaintenance(new AbortController().signal, async () => {
      await finish.promise
      throw failed
    })
    .catch((error: unknown) => error)
  const waiting = gate.acquire(controller.signal).catch((error: unknown) => error)
  const cancelled = new Error("cancel queued read")
  controller.abort(cancelled)
  expect(await waiting).toBe(cancelled)
  finish.resolve()
  expect(await maintenance).toBe(failed)
  // Red check: omit the finally cleanup in withMaintenance. The next reader cannot enter.
  const retry = new AbortController()
  const deadline = setTimeout(() => retry.abort(new Error("admission remained closed")), 200)
  try {
    const release = await gate.acquire(retry.signal)
    release()
  } finally {
    clearTimeout(deadline)
    retry.abort()
  }
})

describe("maintenance beside reads that stay open", () => {
  const signal = new AbortController().signal

  /** Lets what a timer or a release woke run to its next wait. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
  }

  async function advance(ms: number): Promise<void> {
    jest.advanceTimersByTime(ms)
    await settle()
  }

  function track<T>(promise: Promise<T>) {
    const tracked = { settled: false, outcome: promise.catch((error: unknown) => error) }
    void tracked.outcome.then(() => {
      tracked.settled = true
    })
    return tracked
  }

  // Reproduce: remove `DRAIN_REST_MS` and the deadline from claimWithin; this waits for good.
  test("gives up once a read outlasts its wait and its drain", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const release = await gate.acquire(signal)

    const maintenance = track(gate.withMaintenance(signal, async () => {}))
    await advance(WAIT_MS + DRAIN_MS - 1)
    expect(maintenance.settled).toBe(false)

    await advance(1)
    expect(await maintenance.outcome).toBeInstanceOf(DuckLakeReadsBusy)

    release()
  })

  // A pipeline step holding one input may be opening the next: blocking it for good would be a
  // deadlock with the maintenance that waits for it. Reproduce: set `draining` on entry to
  // admitMaintenance.
  test("lets new reads in while it waits", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const first = await gate.acquire(signal)
    const maintenance = track(gate.withMaintenance(signal, async () => {}))

    await advance(WAIT_MS - 1)
    const second = await gate.acquire(signal)

    first()
    second()
    await maintenance.outcome
  })

  // Reproduce: drop the `draining` check from acquire. Reads that overlap then keep maintenance out
  // for good.
  test("gets in past reads that overlap, by holding new ones back", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const first = await gate.acquire(signal)
    let ran = false
    const maintenance = track(
      gate.withMaintenance(signal, async () => {
        ran = true
      })
    )

    await advance(WAIT_MS)
    const held = track(gate.acquire(signal))
    await settle()
    expect(held.settled).toBe(false)

    first()
    await maintenance.outcome
    expect(ran).toBe(true)

    const release = await held.outcome
    if (typeof release === "function") release()
  })

  // Reproduce: claim after an `await` in claimWithin. The held read, woken with it, then enters
  // beside maintenance.
  test("keeps a held read out once it gets in", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const first = await gate.acquire(signal)
    const finish = Promise.withResolvers<void>()
    const maintenance = track(gate.withMaintenance(signal, () => finish.promise))

    await advance(WAIT_MS)
    const held = track(gate.acquire(signal))
    await settle()

    first()
    await settle()
    expect(held.settled).toBe(false)

    finish.resolve()
    await maintenance.outcome

    const release = await held.outcome
    if (typeof release === "function") release()
  })

  // Reproduce: drop the `drainAllowedAt` check from admitMaintenance. A read an hour long then
  // holds every new read back for 5 seconds out of every 35.
  test("holds no read back again for a while after a drain failed", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const long = await gate.acquire(signal)

    const failed = track(gate.withMaintenance(signal, async () => {}))
    await advance(WAIT_MS + DRAIN_MS)
    await failed.outcome

    const next = track(gate.withMaintenance(signal, async () => {}))
    await advance(WAIT_MS)
    expect(await next.outcome).toBeInstanceOf(DuckLakeReadsBusy)

    const read = track(gate.acquire(signal))
    await settle()
    expect(read.settled).toBe(true)

    await advance(DRAIN_REST_MS)
    const drained = track(gate.withMaintenance(signal, async () => {}))
    await advance(WAIT_MS)
    const held = track(gate.acquire(signal))
    await settle()
    expect(held.settled).toBe(false)

    await advance(DRAIN_MS)
    expect(await drained.outcome).toBeInstanceOf(DuckLakeReadsBusy)

    long()
    for (const entry of [await read.outcome, await held.outcome]) {
      if (typeof entry === "function") entry()
    }
  })

  // Reproduce: drop the signal from `wait` in claimWithin.
  test("stops waiting when it is told to, in either phase", async () => {
    jest.useFakeTimers()
    const gate = new DuckLakeReadGate()
    const release = await gate.acquire(signal)
    const reason = new Error("shutting down")

    const waiting = new AbortController()
    const inWait = track(gate.withMaintenance(waiting.signal, async () => {}))
    waiting.abort(reason)
    expect(await inWait.outcome).toBe(reason)

    const draining = new AbortController()
    const inDrain = track(gate.withMaintenance(draining.signal, async () => {}))
    await advance(WAIT_MS)
    draining.abort(reason)
    expect(await inDrain.outcome).toBe(reason)

    // The drain ended with it: reads go on.
    const read = await gate.acquire(signal)
    read()
    release()
  })
})
