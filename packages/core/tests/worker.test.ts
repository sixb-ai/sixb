import { describe, expect, test } from "bun:test"
import { Worker, WorkerUnhealthyError } from "../src"

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker state")
    await Bun.sleep(1)
  }
}

describe("Worker", () => {
  test("starts and stops idempotently", async () => {
    const loop = createDeferred<void>()
    let runs = 0

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        runs += 1
        signal.addEventListener("abort", () => loop.resolve(), { once: true })
        await loop.promise
      }
    }

    const worker = new TestWorker()

    await Promise.all([worker.start(), worker.start()])
    await Promise.all([worker.stop(), worker.stop()])

    expect(runs).toBe(1)
  })

  test("propagates abort on stop", async () => {
    let aborted = false

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true
              resolve()
            },
            { once: true }
          )
        })
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await worker.stop()

    expect(aborted).toBe(true)
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

  test("restarts transient loop failures with bounded backoff", async () => {
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
    await waitFor(() => runs === 3)

    await worker.stop()
    expect(runs).toBe(3)
  })

  test("becomes unhealthy after exhausting the restart budget", async () => {
    let runs = 0

    class TestWorker extends Worker {
      protected async run(): Promise<void> {
        runs += 1
        throw new Error("persistent failure")
      }
    }

    const worker = new TestWorker()
    await worker.start()

    const exit = worker.wait()
    await expect(exit).rejects.toBeInstanceOf(WorkerUnhealthyError)
    await expect(exit).rejects.toMatchObject({
      name: "WorkerUnhealthyError",
      restartCount: 5,
      cause: expect.objectContaining({ message: "persistent failure" }),
    })
    expect(runs).toBe(6)

    await worker.stop()
  })

  test("stop cancels a pending restart", async () => {
    let runs = 0

    class TestWorker extends Worker {
      protected async run(): Promise<void> {
        runs += 1
        throw new Error("restart later")
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await waitFor(() => runs === 1)
    await worker.stop()
    await Bun.sleep(300)

    expect(runs).toBe(1)
  })

  test("stop waits for run() to complete", async () => {
    let finished = false

    class TestWorker extends Worker {
      protected async run(signal: AbortSignal): Promise<void> {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        finished = true
      }
    }

    const worker = new TestWorker()
    await worker.start()
    await worker.stop()

    expect(finished).toBe(true)
  })
})
