import { describe, expect, spyOn, test } from "bun:test"
import {
  type ClaimedQueueJob,
  InMemoryQueues,
  QueueWorker,
  type QueueWorkerFailureDecision,
  type SyncRunRequestedQueueJob,
} from "../src"

const PROJECT_ID = "queue-worker-tests"

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for condition.")
}

describe("QueueWorker", () => {
  test("processes claimed jobs and completes them", async () => {
    const queues = new InMemoryQueues()
    const processed: string[] = []

    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.id)
      }
    }

    const worker = new TestWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 10,
    })

    const [queued] = await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "s" } }],
    })

    await worker.start()
    await waitFor(() => processed.length === 1)
    await worker.stop()

    expect(processed).toEqual([queued!.id])
    const claimed = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "observer" })
    expect(claimed).toHaveLength(0)
  })

  test("restarts the loop after repeated queue claim failures", async () => {
    const queues = new InMemoryQueues()
    const originalClaim = queues.syncRuns.claim.bind(queues.syncRuns)
    let claimCalls = 0
    queues.syncRuns.claim = (params) => {
      claimCalls += 1
      if (claimCalls <= 5) return Promise.reject(new Error("queue unavailable"))
      return originalClaim(params)
    }

    let processed = false
    class TestWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(): Promise<void> {
        processed = true
      }
    }

    const worker = new TestWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 1,
    })
    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "s" } }],
    })

    await worker.start()
    await waitFor(() => processed, 2_000)
    await worker.stop()

    expect(claimCalls).toBeGreaterThan(5)
  })

  test("default policy fails jobs on execution errors", async () => {
    const queues = new InMemoryQueues()

    class FailingWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(): Promise<void> {
        throw new Error("execute failed")
      }
    }

    const worker = new FailingWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 10,
    })

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "s" } }],
    })

    await worker.start()

    await waitFor(async () => {
      const claimed = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "observer" })
      return claimed.length === 0
    })

    await worker.stop()
  })

  test("custom onExecutionError can request retry with availableAt", async () => {
    const queues = new InMemoryQueues()
    let executeCalls = 0

    class RetryingWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(): Promise<void> {
        executeCalls += 1
        if (executeCalls === 1) {
          throw new Error("retry please")
        }
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

    const worker = new RetryingWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 10,
    })

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "s" } }],
    })

    await worker.start()
    await waitFor(() => executeCalls >= 2)
    await worker.stop()

    expect(executeCalls).toBeGreaterThanOrEqual(2)
  })

  test("custom onAbortError can fail abort errors", async () => {
    const queues = new InMemoryQueues()

    class AbortFailingWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(): Promise<void> {
        const error = new Error("aborted")
        error.name = "AbortError"
        throw error
      }

      protected onAbortError(): QueueWorkerFailureDecision {
        return { kind: "fail" }
      }
    }

    const worker = new AbortFailingWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 10,
    })

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "s" } }],
    })

    await worker.start()

    await waitFor(async () => {
      const claimed = await queues.syncRuns.claim({ projectId: PROJECT_ID, workerId: "observer" })
      return claimed.length === 0
    })

    await worker.stop()
  })

  test("renews leases while jobs remain in flight", async () => {
    const queues = new InMemoryQueues()
    const originalRenew = queues.syncRuns.renewLease?.bind(queues.syncRuns)
    if (!originalRenew) throw new Error("Expected in-memory queue lease renewal support.")
    let renewals = 0
    queues.syncRuns.renewLease = async (params) => {
      renewals += 1
      return originalRenew(params)
    }

    const originalComplete = queues.syncRuns.complete.bind(queues.syncRuns)
    let completed = false
    queues.syncRuns.complete = async (params) => {
      await originalComplete(params)
      completed = true
    }

    class SlowWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(): Promise<void> {
        await Bun.sleep(240)
      }
    }

    const worker = new SlowWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      leaseMs: 90,
      idlePollMs: 10,
    })

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "slow" } }],
    })

    await worker.start()
    try {
      await waitFor(() => completed)
      expect(renewals).toBeGreaterThanOrEqual(2)
    } finally {
      await worker.stop()
    }
  })

  test("continues processing after a completion acknowledgement error", async () => {
    const queues = new InMemoryQueues()
    const originalComplete = queues.syncRuns.complete.bind(queues.syncRuns)
    let completionCalls = 0
    queues.syncRuns.complete = async (params) => {
      await originalComplete(params)
      completionCalls += 1
      if (completionCalls === 1) {
        throw new Error("connection dropped after acknowledgement")
      }
    }

    const processed: string[] = []
    class ResilientWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.payload.syncId)
      }
    }

    const worker = new ResilientWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      idlePollMs: 10,
    })
    const consoleError = spyOn(console, "error").mockImplementation(() => {})

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "first" } }],
    })

    await worker.start()
    try {
      await waitFor(() => processed.includes("first") && completionCalls === 1)
      await queues.syncRuns.enqueue({
        projectId: PROJECT_ID,
        jobs: [{ type: "sync.run.requested", payload: { syncId: "second" } }],
      })
      await waitFor(() => processed.includes("second"))
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
    let release: () => void = () => {}
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })

    class BatchWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.id)
        await releasePromise
        completed.push(claimed.job.id)
      }
    }

    const worker = new BatchWorker({
      projectId: PROJECT_ID,
      queue: queues.syncRuns,
      workerId: "w",
      claimLimit: 3,
      idlePollMs: 10,
    })

    await queues.syncRuns.enqueue({
      projectId: PROJECT_ID,
      jobs: [{ type: "sync.run.requested", payload: { syncId: "a" } }],
    })

    await worker.start()
    try {
      await waitFor(() => processed.length === 1)
      await queues.syncRuns.enqueue({
        projectId: PROJECT_ID,
        jobs: [
          { type: "sync.run.requested", payload: { syncId: "b" } },
          { type: "sync.run.requested", payload: { syncId: "c" } },
        ],
      })
      await waitFor(() => processed.length === 3)
      expect(completed).toHaveLength(0)
      release()
      await waitFor(() => completed.length === 3)
    } finally {
      release()
      await worker.stop()
    }

    expect(claimSizes).toContain(2)
  })
})
