import { afterEach, expect, jest, test } from "bun:test"
import { InMemoryQueues, type SixbErrorContext } from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import type { DatasetIngestSummary } from "@sixb/core/storage"
import { runIngestReconciler } from "../src/ingest-reconciler"

const PROJECT_ID = "ingest-reconciliation"
const MINUTE = 60_000

afterEach(() => {
  jest.useRealTimers()
})

function summary(
  input: Partial<DatasetIngestSummary> & { datasetId: string }
): DatasetIngestSummary {
  return {
    pendingDeliveries: 1,
    pendingChanges: 1,
    oldestReceivedAt: new Date(),
    request: 0,
    leaseExpiresAt: null,
    failureStreak: 0,
    lastFlushedAt: null,
    ...input,
  }
}

async function queuedFlushes(queues: InMemoryQueues): Promise<string[]> {
  const claimed = await queues.lake.claim({ projectId: PROJECT_ID, workerId: "test", limit: 10 })
  return claimed.map(({ job }) => job.id)
}

async function turns(count = 20): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// Reproduce: skip the enqueue in `reconcile` (ingest-reconciler.ts); the waiting dataset gets no job.
test("queues a flush for each dataset whose deliveries wait with no flush holding it", async () => {
  const queues = new InMemoryQueues()
  const controller = new AbortController()
  const inbox = {
    summarize: async () => [
      summary({ datasetId: "crm.people", request: 4 }),
      // A flush holds this one: it writes the deliveries itself.
      summary({ datasetId: "crm.orgs", leaseExpiresAt: new Date(Date.now() + MINUTE) }),
      // A lease whose flush has finished and found nothing pending.
      summary({ datasetId: "crm.deals", pendingDeliveries: 0 }),
    ],
  }

  const running = runIngestReconciler(
    { projectId: PROJECT_ID, queues, inbox, reporter: {} },
    controller.signal
  )
  await turns()
  controller.abort()
  await running

  expect(await queuedFlushes(queues)).toEqual(["ingest-flush:crm.people:4"])
})

// Reproduce: measure the stall from the oldest delivery in `reportStalled`, and the dataset a
// flush drained 2 min ago is reported, then again with each new oldest; or drop the lease check,
// and the dataset a flush holds is reported.
test("reports a dataset whose changes nothing wrote for 10 minutes, once per stall", async () => {
  jest.useFakeTimers()
  const host = {}
  const reports: SixbErrorContext[] = []
  attachSixbErrorReporter(host, (_error, context) => {
    reports.push(context)
  })

  const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE)
  const lastFlushedAt = ago(11)
  let pass = 0
  const inbox = {
    summarize: async () => {
      pass += 1
      return [
        // Nothing written for 11 minutes. Its oldest delivery changes between passes, the stall
        // does not.
        summary({
          datasetId: "crm.people",
          pendingDeliveries: 3,
          oldestReceivedAt: ago(pass === 1 ? 40 : 30),
          lastFlushedAt,
        }),
        // An old backlog, but a flush completed a batch 2 minutes ago.
        summary({ datasetId: "crm.deals", oldestReceivedAt: ago(40), lastFlushedAt: ago(2) }),
        // A flush holds it.
        summary({
          datasetId: "crm.notes",
          oldestReceivedAt: ago(40),
          leaseExpiresAt: new Date(Date.now() + MINUTE),
        }),
        // Flushes run and fail: the flush reports those itself.
        summary({ datasetId: "crm.orgs", oldestReceivedAt: ago(40), failureStreak: 2 }),
      ]
    },
  }
  const controller = new AbortController()
  const running = runIngestReconciler(
    {
      projectId: PROJECT_ID,
      queues: new InMemoryQueues(),
      inbox,
      reporter: host,
      intervalMs: MINUTE,
    },
    controller.signal
  )

  await turns()
  jest.advanceTimersByTime(MINUTE)
  await turns()
  controller.abort()
  await running
  await flushSixbErrors(host)

  expect(pass).toBe(2)
  expect(reports).toEqual([
    expect.objectContaining({
      type: "dataset.ingest.flush.failed",
      projectId: PROJECT_ID,
      datasetId: "crm.people",
      failureStreak: 0,
      pendingDeliveries: 3,
      notificationId: `dataset-ingest:${PROJECT_ID}:crm.people:stalled:${lastFlushedAt.toISOString()}`,
    }),
  ])
})
