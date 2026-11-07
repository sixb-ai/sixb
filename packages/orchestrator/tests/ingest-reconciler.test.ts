import { afterEach, expect, jest, test } from "bun:test"
import { InMemoryQueues, type SixbErrorContext } from "@sixb/core"
import { attachSixbErrorReporter, flushSixbErrors } from "@sixb/core/internal/error-reporting"
import type { DatasetIngestSummary } from "@sixb/core/storage"
import { IngestReconciler } from "../src/ingest-reconciler"

const PROJECT_ID = "ingest-reconciliation"
const MINUTE = 60_000

const signal = new AbortController().signal

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

// Reproduce: skip the enqueue in `pass` (ingest-reconciler.ts); the waiting dataset gets no job.
test("queues a flush for each dataset whose deliveries wait with no flush holding it", async () => {
  const queues = new InMemoryQueues()
  const inbox = {
    summarize: async () => [
      summary({ datasetId: "crm.people", request: 4 }),
      // A flush holds this one: it writes the deliveries itself.
      summary({ datasetId: "crm.orgs", leaseExpiresAt: new Date(Date.now() + MINUTE) }),
      // A lease whose flush has finished and found nothing pending.
      summary({ datasetId: "crm.deals", pendingDeliveries: 0 }),
    ],
  }

  const reconciler = new IngestReconciler({
    projectId: PROJECT_ID,
    queue: queues.lake,
    inbox,
    reporter: {},
  })
  await reconciler.pass(signal)

  expect(await queuedFlushes(queues)).toEqual(["ingest-flush:crm.people:4"])
})

// Reproduce: name the job anything but the request in `enqueueIngestFlush`; each pass then adds one.
test("asks for a request's flush again without queueing a second job", async () => {
  const queues = new InMemoryQueues()
  const reconciler = new IngestReconciler({
    projectId: PROJECT_ID,
    queue: queues.lake,
    inbox: { summarize: async () => [summary({ datasetId: "crm.people", request: 4 })] },
    reporter: {},
  })

  await reconciler.pass(signal)
  await reconciler.pass(signal)

  expect(await queuedFlushes(queues)).toEqual(["ingest-flush:crm.people:4"])
})

// Reproduce: wrap the enqueue in `pass` in a catch; the loop then counts a queue that is down as a
// pass that worked, and nothing says so.
test("fails the pass when the queue refuses, for the loop to count and report", async () => {
  const reconciler = new IngestReconciler({
    projectId: PROJECT_ID,
    queue: {
      enqueue: async () => {
        throw new Error("queue offline")
      },
    },
    inbox: { summarize: async () => [summary({ datasetId: "crm.people" })] },
    reporter: {},
  })

  const failure = await reconciler.pass(signal).catch((error) => error)

  expect(failure).toEqual(new Error("queue offline"))
})

// Reproduce: report after queueing in `pass`; a queue that is down then silences the report.
test("reports a stall even when the queue refuses", async () => {
  const host = {}
  const reports: SixbErrorContext[] = []
  attachSixbErrorReporter(host, (_error, context) => {
    reports.push(context)
  })
  const reconciler = new IngestReconciler({
    projectId: PROJECT_ID,
    queue: {
      enqueue: async () => {
        throw new Error("queue offline")
      },
    },
    inbox: {
      summarize: async () => [
        summary({
          datasetId: "crm.people",
          oldestReceivedAt: new Date(Date.now() - 11 * MINUTE),
        }),
      ],
    },
    reporter: host,
  })

  await reconciler.pass(signal).catch(() => {})
  await flushSixbErrors(host)

  expect(reports).toEqual([expect.objectContaining({ datasetId: "crm.people" })])
})

// Reproduce: measure the stall from the oldest delivery in `reportStalled`, and the dataset a
// flush drained 2 min ago is reported, then again with each new oldest; drop the lease check, and
// the dataset a flush holds is reported; or drop the `reported` check, and each pass reports.
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
  const reconciler = new IngestReconciler({
    projectId: PROJECT_ID,
    queue: new InMemoryQueues().lake,
    inbox,
    reporter: host,
  })

  await reconciler.pass(signal)
  jest.advanceTimersByTime(MINUTE)
  await reconciler.pass(signal)
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
