import { expect, test } from "bun:test"
import {
  col,
  defineConnector,
  defineDataset,
  definePipeline,
  definePipelineStep,
  defineSchedule,
  defineSync,
  events,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  SixbHost,
} from "@sixb/core"
import { createTestSixb } from "@sixb/core/testing"
import { startSixbRuntime } from "../src/lib/runtime"

const ads = defineConnector("ads", {
  type: "ads-oauth",
  authentication: {
    type: "oauth2",
    authorizationUrl: () => "https://provider.test/oauth",
    exchangeCode: () => ({ accessToken: "access" }),
    refresh: () => ({ accessToken: "refreshed" }),
  },
  discoverAccounts: () => [],
  connect: (context) => ({ accountId: context.account.id }),
})

const campaigns = defineDataset("raw.ads.campaigns", {
  schema: [col("id", "string"), col("spend", "float64")],
  primaryKey: "id",
})
const spend = defineDataset("report.ads.spend", { schema: [col("campaigns", "int64")] })

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (ready(value)) return value
    await Bun.sleep(10)
  }
  throw new Error("[Test] Timed out waiting for the pipeline run.")
}

// Before this, a sync of an OAuth connector no one had connected queued no run, its dataset never
// existed, and the pipeline reading it failed with "has no committed version". To watch that fail,
// drop the no-account branch from `requestSyncRun`, or `createInitialVersion` from the sync worker.
test("a sync of an OAuth connector with no account creates its dataset, and pipelines read it", async () => {
  let reads = 0
  const sync = defineSync("import-campaigns", { mode: "merge" })
    .from(ads)
    .read(() => {
      reads += 1
      return []
    })
    .intoDataset(campaigns)
  const campaignsUpdated = defineSchedule("campaigns-updated").on(
    events.dataset(campaigns).updated()
  )
  const pipeline = definePipeline("ads-spend")
    .when(campaignsUpdated)
    .then(
      definePipelineStep("count-campaigns")
        .inputs({ campaigns })
        .output(spend)
        .run(async ({ inputs, output }) => {
          let count = 0
          for await (const _row of inputs.campaigns.readRows()) count += 1
          await output.writeRows([{ campaigns: count }])
        })
    )
  const host = new SixbHost({
    id: "sync-without-accounts",
    ontology: [],
    datasets: [campaigns, spend],
    connectors: [ads],
    syncs: [sync],
    schedules: [campaignsUpdated],
    pipelines: [pipeline],
    connectorConnections: { encryptionKey: Buffer.alloc(32, 7).toString("base64url") },
    lakeStorage: new InMemoryLakeStorage(),
    storage: new InMemoryStorage(),
    queues: new InMemoryQueues(),
    broker: new InMemoryBroker(),
    blobStorage: new InMemoryBlobStorage(),
    onError: () => {},
  })
  const sixb = createTestSixb(host)
  const runtime = await startSixbRuntime(host, { cohostWorkers: true })

  try {
    const { runs } = await sixb.syncs.request({ syncId: sync.id })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.connectionId).toBeUndefined()

    const {
      runs: [run],
    } = await waitFor(
      () => host.storage.pipelineRuns!.list({ projectId: host.id, pipelineId: pipeline.id }),
      (result) => result.runs.some(({ status }) => status === "succeeded" || status === "failed")
    )
    expect(run?.status).toBe("succeeded")
    expect(reads).toBe(0)

    const rows = []
    for await (const row of host.lakeStorage.readRows({ datasetId: spend.id })) rows.push(row)
    expect(rows).toEqual([{ campaigns: 0 }])
  } finally {
    await runtime.stop()
  }
})
