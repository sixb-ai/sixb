import { describe, expect, test } from "bun:test"
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

  test("claimLimit batches multiple jobs per claim", async () => {
    const queues = new InMemoryQueues()
    const claimSizes: number[] = []
    const originalClaim = queues.syncRuns.claim.bind(queues.syncRuns)
    queues.syncRuns.claim = async (params) => {
      const result = await originalClaim(params)
      if (result.length > 0) claimSizes.push(result.length)
      return result
    }

    const processed: string[] = []

    class BatchWorker extends QueueWorker<SyncRunRequestedQueueJob> {
      protected async execute(claimed: ClaimedQueueJob<SyncRunRequestedQueueJob>): Promise<void> {
        processed.push(claimed.job.id)
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
      jobs: [
        { type: "sync.run.requested", payload: { syncId: "a" } },
        { type: "sync.run.requested", payload: { syncId: "b" } },
        { type: "sync.run.requested", payload: { syncId: "c" } },
      ],
    })

    await worker.start()
    await waitFor(() => processed.length === 3)
    await worker.stop()

    expect(claimSizes[0]).toBe(3)
  })
})
