import { expect, test } from "bun:test"
import { DuckLakeReadGate } from "../src/internal/ducklake-read-gate"

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
