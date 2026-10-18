import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { InMemoryQueues } from "../src"
import { createSixbError } from "../src/errors/internal"
import type {
  ClaimedQueueJob,
  QueueJobFailure,
  SyncQueueJobFailureCode,
  SyncRunRequestedQueueJob,
} from "../src/queues"
import { SYNC_RUN_FAILURE_CODES } from "../src/storage"
import { QueueWorker, type QueueWorkerFailureDecision } from "../src/workers"

const PROJECT_ID = "queue-worker-tests"

afterEach(() => {
  jest.useRealTimers()
})

/** `setImmediate` stays real under Bun's fake timers, so this drains every pending microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Fires fake timers one at a time, letting the worker's real promise chains settle in between. */
async function runTimersUntil(done: () => boolean): Promise<void> {
  for (let step = 0; step < 1_000 && !done(); step++) {
    await flush()
    jest.advanceTimersToNextTimer()
  }
}

function workerConfig(queues: InMemoryQueues) {
  return {
    projectId: PROJECT_ID,
    queue: queues.syncRuns,
    failureCodes: SYNC_RUN_FAILURE_CODES,
    workerId: "w",
  }
}

function enqueue(queues: InMemoryQueues, runId = "s") {
  return queues.syncRuns.enqueue({
    projectId: PROJECT_ID,
    jobs: [{ type: "sync.run.requested", payload: { runId } }],
  })
}

/** Records the failure each settlement persists and signals the first one. */
function recordFailures(queues: InMemoryQueues) {
  const settled = Promise.withResolvers<QueueJobFailure<SyncQueueJobFailureCode>>()
  const originalFail = queues.syncRuns.fail.bind(queues.syncRuns)
  queues.syncRuns.fail = async (params) => {
    await originalFail(params)
    settled.resolve(params.failure)
  }
  return settled.promise
}

describe("QueueWorker", () => {
  test("defaults to one concurrent job and rejects invalid claim limits", () => {
    const queues = new InMemoryQueues()
    class InspectableWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(): Promise<void> {}
    }

    const defaults = workerConfig(queues)
    expect(new InspectableWorker(defaults).concurrency).toBe(1)
    expect(new InspectableWorker({ ...defaults, claimLimit: 3 }).concurrency).toBe(3)

    for (const claimLimit of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new InspectableWorker({ ...defaults, claimLimit })).toThrow(
        "Worker concurrency must be a positive safe integer"
      )
    }
  })

  test("processes claimed jobs and completes them", async () => {
    const queues = new InMemoryQueues()
    const processed: string[] = []
    const executed = Promise.withResolvers<void>()

    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.id)
        executed.resolve()
      }
    }

    const worker = new TestWorker(workerConfig(queues))
    const [queued] = await enqueue(queues)

    await worker.start()
    await executed.promise
    await worker.stop()

    expect(processed).toEqual([queued!.id])
    const claimed = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "observer" })
    expect(claimed).toHaveLength(0)
  })

  // To see this fail, sleep 1s after an empty claim in `QueueWorker.claim` instead of passing the
  // signal: the job then waits out a sleep that fake time never advances.
  test("picks up a job enqueued while idle without waiting out a poll interval", async () => {
    jest.useFakeTimers()
    const queues = new InMemoryQueues()
    let processed = false
    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected async execute(): Promise<void> {
        processed = true
      }
    }
    const worker = new TestWorker(workerConfig(queues))

    await worker.start()
    await flush()
    await enqueue(queues)
    await flush()

    expect(processed).toBe(true)
    await worker.stop()
  })

  // To see this fail, remove the empty-claim check in `QueueWorker.claim`: the worker then claims
  // in a loop until `runTimersUntil` gives up, and never reports anything.
  test("fails loudly instead of spinning when a queue ignores the claim signal", async () => {
    jest.useFakeTimers()
    const queues = new InMemoryQueues()
    let claimCalls = 0
    // Answers at once whatever the signal, like a plain non-blocking claim.
    queues.syncRuns.claim = async () => {
      claimCalls += 1
      await new Promise((resolve) => setImmediate(resolve))
      return []
    }
    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected async execute(): Promise<void> {}
    }
    const worker = new TestWorker(workerConfig(queues))

    await worker.start()
    let failure: unknown
    const exit = worker.wait().catch((error: unknown) => {
      failure = error
    })
    await runTimersUntil(() => failure !== undefined)
    await worker.stop()
    await exit

    const messages: string[] = []
    for (let error = failure; error instanceof Error; error = error.cause) {
      messages.push(error.message)
    }
    expect(messages.join("\n")).toContain("claim must wait for work until its signal aborts")
    expect(claimCalls).toBeLessThan(100)
  })

  // To see this fail, drop the `CLAIM_FAILURE_DELAY_MS` sleep in `QueueWorker.claim`: the worker
  // then retries a failed claim at once, and burns through all five before any time passes.
  test("restarts the loop after repeated queue claim failures", async () => {
    jest.useFakeTimers()
    const queues = new InMemoryQueues()
    const originalClaim = queues.syncRuns.claim.bind(queues.syncRuns)
    let claimCalls = 0
    queues.syncRuns.claim = (params) => {
      claimCalls += 1
      if (claimCalls <= 5) return Promise.reject(new Error("queue unavailable"))
      return originalClaim(params)
    }

    let runs = 0
    let claimedOnCall: number | undefined
    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected override run(signal: AbortSignal): Promise<void> {
        runs += 1
        return super.run(signal)
      }

      protected async execute(): Promise<void> {
        claimedOnCall = claimCalls
      }
    }

    const worker = new TestWorker(workerConfig(queues))
    await enqueue(queues)

    await worker.start()
    await flush()
    // A failed claim is retried after a second, not at once.
    jest.advanceTimersByTime(999)
    await flush()
    expect(claimCalls).toBe(1)
    jest.advanceTimersByTime(1)
    await flush()
    expect(claimCalls).toBe(2)

    await runTimersUntil(() => claimedOnCall !== undefined)
    await worker.stop()

    // Five failures exhaust the loop; the supervisor restarts it and the next claim succeeds.
    expect(claimedOnCall).toBe(6)
    expect(runs).toBe(2)
  })

  test("default policy fails jobs on execution errors", async () => {
    const queues = new InMemoryQueues()
    const settled = recordFailures(queues)

    class FailingWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(): Promise<void> {
        throw createSixbError("internal.unexpected", "execute failed", {
          cause: new Error("storage unavailable"),
          details: { syncId: "s" },
        })
      }
    }

    const worker = new FailingWorker(workerConfig(queues))
    await enqueue(queues)

    await worker.start()
    const settledFailure = await settled
    await worker.stop()

    expect(settledFailure).toMatchObject({
      code: "internal.unexpected",
      retryable: false,
      message: "An unexpected internal error occurred.",
      details: { syncId: "s" },
    })
    expect(Date.parse(settledFailure.at)).not.toBeNaN()
  })

  test("settles with the exact durable failure supplied by a worker", async () => {
    const queues = new InMemoryQueues()
    const failure: QueueJobFailure<SyncQueueJobFailureCode> = {
      code: "sync.execution_failed",
      message: "Sync execution failed.",
      retryable: false,
      at: "2026-08-21T12:00:00.000Z",
      details: { syncId: "s", runId: "run-s" },
    }
    const settled = recordFailures(queues)

    class DurableFailingWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(): Promise<void> {
        throw new Error("private provider diagnostic")
      }

      protected onExecutionError(): QueueWorkerFailureDecision<SyncQueueJobFailureCode> {
        return { kind: "fail", failure }
      }
    }

    const worker = new DurableFailingWorker(workerConfig(queues))
    await enqueue(queues, "run-s")

    await worker.start()
    expect(await settled).toEqual(failure)
    await worker.stop()
  })

  test("custom onExecutionError can request retry with availableAt", async () => {
    const queues = new InMemoryQueues()
    let executeCalls = 0
    const retried = Promise.withResolvers<void>()

    class RetryingWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(): Promise<void> {
        executeCalls += 1
        if (executeCalls === 1) {
          throw new Error("retry please")
        }
        retried.resolve()
      }

      protected onExecutionError(
        claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>
      ): QueueWorkerFailureDecision {
        if (claimed.job.attempt < 3) {
          return { kind: "retry", availableAt: new Date(Date.now() - 1).toISOString() }
        }
        return { kind: "fail" }
      }
    }

    const worker = new RetryingWorker(workerConfig(queues))
    await enqueue(queues)

    await worker.start()
    await retried.promise
    await worker.stop()

    expect(executeCalls).toBe(2)
  })

  test("custom onAbortError can fail abort errors", async () => {
    const queues = new InMemoryQueues()
    const settled = recordFailures(queues)

    class AbortFailingWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(): Promise<void> {
        const error = new Error("aborted")
        error.name = "AbortError"
        throw error
      }

      protected onAbortError(): QueueWorkerFailureDecision {
        return { kind: "fail" }
      }
    }

    const worker = new AbortFailingWorker(workerConfig(queues))
    await enqueue(queues)

    await worker.start()
    const settledFailure = await settled
    await worker.stop()

    expect(settledFailure).toMatchObject({
      code: "runtime.cancelled",
      retryable: false,
      message: "Execution was cancelled.",
    })
  })

  test("renews leases while jobs remain in flight", async () => {
    jest.useFakeTimers()
    const queues = new InMemoryQueues()
    const originalRenew = queues.syncRuns.renewLease?.bind(queues.syncRuns)
    if (!originalRenew) throw new Error("Expected in-memory queue lease renewal support.")
    let renewals = 0
    queues.syncRuns.renewLease = async (params) => {
      renewals += 1
      return originalRenew(params)
    }

    const originalComplete = queues.syncRuns.complete.bind(queues.syncRuns)
    const completed = Promise.withResolvers<void>()
    queues.syncRuns.complete = async (params) => {
      await originalComplete(params)
      completed.resolve()
    }

    const executing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    class SlowWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected async execute(): Promise<void> {
        executing.resolve()
        await release.promise
      }
    }

    const worker = new SlowWorker({ ...workerConfig(queues), leaseMs: 90 })
    await enqueue(queues, "slow")

    await worker.start()
    try {
      await executing.promise
      // Three lease thirds outlive the original 90ms lease; each renewal keeps ownership.
      for (let third = 0; third < 3; third++) {
        jest.advanceTimersByTime(30)
        await flush()
      }
      expect(renewals).toBe(3)
      release.resolve()
      await completed.promise
    } finally {
      release.resolve()
      await worker.stop()
    }
  })

  test("continues processing after a completion acknowledgement error", async () => {
    const queues = new InMemoryQueues()
    const originalComplete = queues.syncRuns.complete.bind(queues.syncRuns)
    const firstCompletion = Promise.withResolvers<void>()
    let completionCalls = 0
    queues.syncRuns.complete = async (params) => {
      await originalComplete(params)
      completionCalls += 1
      if (completionCalls === 1) {
        firstCompletion.resolve()
        throw new Error("connection dropped after acknowledgement")
      }
    }

    const secondProcessed = Promise.withResolvers<void>()
    class ResilientWorker extends QueueWorker<
      SyncRunRequestedQueueJob,
      typeof SYNC_RUN_FAILURE_CODES
    > {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        if (claimed.job.payload.runId === "second") secondProcessed.resolve()
      }
    }

    const worker = new ResilientWorker(workerConfig(queues))
    const consoleError = spyOn(console, "error").mockImplementation(() => {})

    await enqueue(queues, "first")

    await worker.start()
    try {
      await firstCompletion.promise
      await enqueue(queues, "second")
      await secondProcessed.promise
      expect(consoleError).toHaveBeenCalled()
    } finally {
      await worker.stop()
      consoleError.mockRestore()
    }
  })

  test("claimLimit batches and executes multiple jobs concurrently", async () => {
    const queues = new InMemoryQueues()
    const claimSizes: number[] = []
    const originalClaim = queues.syncRuns.claim.bind(queues.syncRuns)
    queues.syncRuns.claim = async (params) => {
      const result = await originalClaim(params)
      if (result.length > 0) claimSizes.push(result.length)
      return result
    }

    const processed: string[] = []
    const completed: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const allStarted = Promise.withResolvers<void>()
    const allCompleted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()

    class BatchWorker extends QueueWorker<SyncRunRequestedQueueJob, typeof SYNC_RUN_FAILURE_CODES> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.id)
        if (processed.length === 1) firstStarted.resolve()
        if (processed.length === 3) allStarted.resolve()
        await release.promise
        completed.push(claimed.job.id)
        if (completed.length === 3) allCompleted.resolve()
      }
    }

    const worker = new BatchWorker({ ...workerConfig(queues), claimLimit: 3 })
    await enqueue(queues, "a")

    await worker.start()
    try {
      await firstStarted.promise
      await queues.syncRuns.enqueue({
        projectId: PROJECT_ID,
        jobs: [
          { type: "sync.run.requested", payload: { runId: "b" } },
          { type: "sync.run.requested", payload: { runId: "c" } },
        ],
      })
      await allStarted.promise
      expect(completed).toHaveLength(0)
      release.resolve()
      await allCompleted.promise
    } finally {
      release.resolve()
      await worker.stop()
    }

    expect(claimSizes).toContain(2)
  })
})
