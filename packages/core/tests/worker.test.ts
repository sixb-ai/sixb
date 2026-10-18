import { afterEach, describe, expect, jest, test } from "bun:test"
import { Worker, WorkerUnhealthyError } from "../src/workers"

afterEach(() => {
  jest.useRealTimers()
})

/** `setImmediate` stays real under Bun's fake timers, so this drains every pending microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("Worker", () => {
  test("starts and stops idempotently", async () => {
    let runs = 0
    let runSignal: AbortSignal | undefined

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        runs += 1
        runSignal = signal
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    }

    const worker = new TestWorker()

    await Promise.all([worker.start(), worker.start()])
    await Promise.all([worker.stop(), worker.stop()])

    expect(runs).toBe(1)
    expect(runSignal?.aborted).toBe(true)
  })

  test("can be restarted after stop", async () => {
    let runs = 0

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        runs += 1
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await worker.stop()
    await worker.start()
    await worker.stop()

    expect(runs).toBe(2)
  })

  test("restarts transient loop failures after an exponential backoff", async () => {
    jest.useFakeTimers()
    let runs = 0

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        runs += 1
        if (runs < 3) throw new Error(`transient ${runs}`)
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await flush()
    expect(runs).toBe(1)

    for (const [backoffMs, runsAfter] of [
      [100, 2],
      [200, 3],
    ] as const) {
      jest.advanceTimersByTime(backoffMs - 1)
      await flush()
      expect(runs).toBe(runsAfter - 1)
      jest.advanceTimersByTime(1)
      await flush()
      expect(runs).toBe(runsAfter)
    }

    await worker.stop()
    expect(runs).toBe(3)
  })

  test("becomes unhealthy after exhausting the capped restart budget", async () => {
    jest.useFakeTimers()
    const runStartedAt: number[] = []

    class TestWorker extends Worker {
      protected async run(): Promise<void> {
        runStartedAt.push(Date.now())
        throw new Error("persistent failure")
      }
    }

    const worker = new TestWorker()
    await worker.start()

    let failure: unknown
    const exit = worker.wait().catch((error: unknown) => {
      failure = error
    })
    for (let step = 0; step < 20 && failure === undefined; step++) {
      await flush()
      jest.advanceTimersToNextTimer()
    }
    await exit

    expect(failure).toBeInstanceOf(WorkerUnhealthyError)
    expect(failure).toMatchObject({
      name: "WorkerUnhealthyError",
      restartCount: 10,
      cause: expect.objectContaining({ message: "persistent failure" }),
    })
    // Ten restarts double from 100ms and cap at 30s, riding out ~80s of continuous failure.
    expect(runStartedAt.slice(1).map((at, index) => at - runStartedAt[index]!)).toEqual([
      100, 200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000,
    ])

    await worker.stop()
  })

  test("stop cancels a pending restart", async () => {
    jest.useFakeTimers()
    let runs = 0

    class TestWorker extends Worker {
      protected async run(): Promise<void> {
        runs += 1
        throw new Error("restart later")
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await flush()
    expect(runs).toBe(1)
    expect(jest.getTimerCount()).toBe(1)

    await worker.stop()
    expect(jest.getTimerCount()).toBe(0)
    jest.advanceTimersByTime(60_000)
    await flush()

    expect(runs).toBe(1)
  })

  test("stop waits for run() to complete", async () => {
    const release = Promise.withResolvers<void>()
    let finished = false

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        await release.promise
        finished = true
      }
    }

    const worker = new TestWorker()
    await worker.start()

    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    await flush()
    expect(stopped).toBe(false)

    release.resolve()
    await stopping
    expect(finished).toBe(true)
  })
})
