import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  getProjectionDispatchDescriptors,
  type ProjectionDispatchDescriptor,
  ProjectionRunDispatcher,
} from "@sixb/core/internal/projections"
import { ProjectionDispatchReconciler } from "../src/projection-dispatch-reconciler"

const Invoice = defineObjectType({
  id: "Invoice",
  name: "Invoice",
  properties: [prop("id", "string", { required: true, primary: true })],
})
const invoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
const invoiceProjection = defineProjection("invoice-projection", Invoice)
  .fromDataset(invoices)
  .properties({ id: "id" })

const INTERVAL_MS = 30_000

function createReconciliation() {
  const storage = new InMemoryStorage()
  const lakeStorage = new InMemoryLakeStorage()
  const queues = new InMemoryQueues()
  const host = new SixbHost({
    id: "projection-reconciliation-tests",
    ontology: [Invoice],
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    storage,
    lakeStorage,
    queues,
    datasets: [invoices],
    projections: [invoiceProjection],
  })
  const dispatcher = new ProjectionRunDispatcher(host)
  const lookups: string[] = []
  const feed = { failures: 0 }
  const createReconciler = (descriptors = getProjectionDispatchDescriptors(host)) =>
    new ProjectionDispatchReconciler({
      projectId: host.id,
      dispatcher,
      descriptors,
      lakeStorage: {
        async listLatestVersionsSince(input) {
          if (feed.failures > 0) {
            feed.failures -= 1
            throw new Error("catalog unavailable")
          }
          return lakeStorage.listLatestVersionsSince(input)
        },
        listVersions: (datasetId, limit) => lakeStorage.listVersions(datasetId, limit),
        getVersion: (datasetId, versionId) => lakeStorage.getVersion(datasetId, versionId),
        getLatestVersion(datasetId) {
          lookups.push(datasetId)
          return lakeStorage.getLatestVersion(datasetId)
        },
      },
      projectionRuns: storage.projectionRuns,
      intervalMs: INTERVAL_MS,
    })

  return {
    host,
    feed,
    lookups,
    queues,
    dispatcher,
    createReconciler,
    async commit(id: string) {
      await lakeStorage.createDataset(invoices)
      const write = await lakeStorage.beginWrite({ dataset: invoices, mode: "snapshot" })
      await write.writeRows([{ id }])
      return write.commit()
    },
    async runVersions() {
      const { runs } = await storage.projectionRuns.list({ projectId: host.id, order: "asc" })
      return runs.map((run) => ({
        versionId: run.identity.datasetVersion.versionId,
        status: run.status,
      }))
    },
    async runIdFor(versionId: string) {
      const { runs } = await storage.projectionRuns.list({
        projectId: host.id,
        datasetVersionId: versionId,
      })
      if (runs.length !== 1) throw new Error(`Expected one run for '${versionId}'.`)
      return runs[0]!.id
    },
    async publishedRunIds() {
      const jobs = await queues.projections.claim({
        projectId: host.id,
        workerId: "test",
        limit: 100,
      })
      return jobs.map((claimed) => claimed.job.id).sort()
    },
    async failNextPublish() {
      const enqueue = queues.projections.enqueue.bind(queues.projections)
      queues.projections.enqueue = async () => {
        queues.projections.enqueue = enqueue
        throw new Error("queue unavailable")
      }
    },
    failEnqueue(runId: string) {
      return storage.projectionRuns.failEnqueue({
        id: runId,
        projectId: host.id,
        error: {
          code: "queue.enqueue_failed",
          message: "queue unavailable",
          retryable: true,
          at: new Date().toISOString(),
        },
      })
    },
  }
}

function pinned(version: { datasetId: string; versionId: string; createdAt: Date }) {
  return {
    projectionId: invoiceProjection.id,
    datasetVersion: {
      datasetId: version.datasetId,
      versionId: version.versionId,
      createdAt: version.createdAt.toISOString(),
    },
  }
}

describe("ProjectionDispatchReconciler", () => {
  test("dispatches a commit whose event was dropped and only reads the feed while idle", async () => {
    // Red check: skip the change-feed versions in reconcileTriggers; the commit is never admitted.
    const reconciliation = createReconciliation()
    const reconciler = reconciliation.createReconciler()
    await reconciler.pass()

    const version = await reconciliation.commit("invoice-1")
    reconciliation.lookups.length = 0
    await reconciler.pass()
    await reconciler.pass()
    await reconciler.pass()

    expect(await reconciliation.runVersions()).toEqual([
      { versionId: version.versionId, status: "queued" },
    ])
    expect(reconciliation.lookups).toEqual([])
  })

  test("a restart admits the latest commit made while no orchestrator ran", async () => {
    const reconciliation = createReconciliation()
    await reconciliation.createReconciler().pass()
    await reconciliation.commit("invoice-1")
    const latest = await reconciliation.commit("invoice-2")

    await reconciliation.createReconciler().pass()

    expect(await reconciliation.runVersions()).toEqual([
      { versionId: latest.versionId, status: "queued" },
    ])
  })

  test("keeps reconciling while the change feed fails", async () => {
    // Red check: treat lookups made without a feed read as verified; the second commit is missed.
    const reconciliation = createReconciliation()
    const first = await reconciliation.commit("invoice-1")
    const reconciler = reconciliation.createReconciler()
    reconciliation.feed.failures = 1
    await quietly(() => reconciler.pass())
    expect(await reconciliation.runVersions()).toEqual([
      { versionId: first.versionId, status: "queued" },
    ])

    const second = await reconciliation.commit("invoice-2")
    await reconciler.pass()

    expect(await reconciliation.runVersions()).toContainEqual({
      versionId: second.versionId,
      status: "queued",
    })
  })

  test("republishes a run left queued by a lost publication", async () => {
    // Red check: return early from republishStuckRuns; the stranded run never reaches the queue.
    const reconciliation = createReconciliation()
    const stranded = await reconciliation.commit("invoice-1")
    await reconciliation.failNextPublish()
    await expect(reconciliation.dispatcher.dispatch(pinned(stranded))).rejects.toThrow(
      "queue unavailable"
    )
    const latest = await reconciliation.commit("invoice-2")
    const reconciler = reconciliation.createReconciler()

    const now = Date.now()
    await reconciler.pass(now)
    const strandedRunId = await reconciliation.runIdFor(stranded.versionId)
    const latestRunId = await reconciliation.runIdFor(latest.versionId)
    expect(await reconciliation.publishedRunIds()).toEqual([latestRunId])

    await reconciler.pass(now + INTERVAL_MS + 1_000)
    expect(await reconciliation.publishedRunIds()).toEqual([strandedRunId])
    expect(await reconciliation.runVersions()).toContainEqual({
      versionId: stranded.versionId,
      status: "queued",
    })
  })

  test("requeues a run whose publication failed retryably", async () => {
    const reconciliation = createReconciliation()
    const stranded = await reconciliation.commit("invoice-1")
    await reconciliation.failNextPublish()
    await expect(reconciliation.dispatcher.dispatch(pinned(stranded))).rejects.toThrow(
      "queue unavailable"
    )
    const strandedRunId = await reconciliation.runIdFor(stranded.versionId)
    await reconciliation.failEnqueue(strandedRunId)
    await reconciliation.commit("invoice-2")

    await reconciliation.createReconciler().pass()

    expect(await reconciliation.runVersions()).toContainEqual({
      versionId: stranded.versionId,
      status: "queued",
    })
    expect(await reconciliation.publishedRunIds()).toContain(strandedRunId)
  })

  test("leaves a stranded run of an earlier projection revision alone", async () => {
    const reconciliation = createReconciliation()
    const stranded = await reconciliation.commit("invoice-1")
    await reconciliation.failNextPublish()
    await expect(reconciliation.dispatcher.dispatch(pinned(stranded))).rejects.toThrow(
      "queue unavailable"
    )
    const strandedRunId = await reconciliation.runIdFor(stranded.versionId)
    await reconciliation.commit("invoice-2")
    const revised = getProjectionDispatchDescriptors(reconciliation.host).map(
      (descriptor) =>
        ({ ...descriptor, projectionRevision: "revised" }) as ProjectionDispatchDescriptor
    )

    await reconciliation.createReconciler(revised).pass(Date.now() + INTERVAL_MS + 1_000)

    expect(await reconciliation.publishedRunIds()).not.toContain(strandedRunId)
  })
})

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const originalError = console.error
  console.error = () => {}
  try {
    return await run()
  } finally {
    console.error = originalError
  }
}
