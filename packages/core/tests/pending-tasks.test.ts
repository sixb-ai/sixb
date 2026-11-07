import { afterEach, describe, expect, jest, test } from "bun:test"
import { PendingTasks } from "../src/pending-tasks"

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("PendingTasks", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test("drains at once when nothing is tracked", async () => {
    expect(await new PendingTasks().drain(1_000)).toBe(true)
  })

  test("waits for tracked work and forgets it once it settles", async () => {
    const tasks = new PendingTasks()
    const work = deferred()
    tasks.track(work.promise)
    expect(tasks.size).toBe(1)

    let drained = false
    const draining = tasks.drain(1_000).then((result) => {
      drained = result
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    work.resolve()
    await draining
    expect(drained).toBe(true)
    expect(tasks.size).toBe(0)
  })

  test("only waits for work that fails: the rejection is the starter's to handle", async () => {
    const tasks = new PendingTasks()
    const work = deferred()
    tasks.track(work.promise)
    work.reject(new Error("boom"))

    expect(await tasks.drain(1_000)).toBe(true)
    expect(tasks.size).toBe(0)
  })

  test("also waits for work tracked while it waits", async () => {
    const tasks = new PendingTasks()
    const first = deferred()
    const second = deferred()
    tasks.track(first.promise.then(() => tasks.track(second.promise)))

    let drained = false
    const draining = tasks.drain(1_000).then((result) => {
      drained = result
    })
    first.resolve()
    // Let the first task settle and start the second: every pending microtask runs before this.
    await new Promise((resolve) => setImmediate(resolve))
    expect(drained).toBe(false)

    second.resolve()
    await draining
    expect(drained).toBe(true)
  })

  // Reproduce: drop the timeout race in settleWithin and this never settles, so it dies at the
  // per-test timeout instead of reporting `false`.
  test("gives up with false when work never settles", async () => {
    jest.useFakeTimers()
    const tasks = new PendingTasks()
    tasks.track(new Promise<void>(() => {}))

    const draining = tasks.drain(5_000)
    jest.advanceTimersByTime(5_000)

    expect(await draining).toBe(false)
    expect(tasks.size).toBe(1)
  })
})
