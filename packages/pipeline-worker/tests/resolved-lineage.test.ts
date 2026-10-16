import { describe, expect, test } from "bun:test"
import {
  AuthorizationError,
  can,
  col,
  type DatasetDefinition,
  defineDataset,
  defineGroup,
  defineMarking,
  definePipeline,
  definePipelineStep,
  defineRole,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import type { DatasetVersion, LakeStorage } from "@sixb/core/lake-storage"
import { createTestSixb } from "@sixb/core/testing"
import { PipelineWorker } from "../src"

// The worked example of resolved lineage, run by the worker: a sync merges invoices, a step
// normalizes them, and an append step keeps a history of what it normalized. On day 1 the step
// writes amounts into the titles; on day 2 it is fixed.

const financial = defineMarking("financial")
const rawInvoices = defineDataset("raw_invoices", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("amount", "decimal", { markings: [financial] }),
  ],
  primaryKey: "id",
})
const normalized = defineDataset("normalized", {
  schema: [col("id", "string"), col("title", "string")],
})
const history = defineDataset("history", {
  schema: [col("id", "string"), col("title", "string")],
})

const analysts = defineGroup("analysts")
const reader = defineRole("reader", {
  grantedTo: [analysts],
  grants: [can.view(normalized), can.view(history)],
})

interface Day {
  /** The raw column the step writes into `title`. */
  readonly title: "amount" | "title"
  readonly historyMode: "append" | "snapshot"
}

function deploy(lakeStorage: LakeStorage, day: Day) {
  const normalize = definePipelineStep("normalize")
    .inputs({ invoices: rawInvoices.pick("id", day.title) })
    .output(normalized)
    .run(async ({ inputs, output }) => {
      const rows = []
      for await (const row of inputs.invoices.readRows()) {
        rows.push({ id: row.id, title: String(row[day.title]) })
      }
      await output.writeRows(rows)
    })
  const keepHistory = definePipelineStep("keep-history")
    .inputs({ normalized })
    .output(history, { mode: day.historyMode })
    .run(async ({ inputs, output }) => {
      await output.writeRows(inputs.normalized.readRows())
    })
  return new SixbHost({
    id: "resolved-lineage",
    ontology: [],
    markings: [financial],
    groups: [analysts],
    roles: [reader],
    datasets: [rawInvoices, normalized, history],
    pipelines: [definePipeline("invoices").then(normalize).then(keepHistory)],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  })
}

async function sync(lakeStorage: LakeStorage, id: string) {
  await lakeStorage.createDataset(rawInvoices)
  const merge = await lakeStorage.beginMerge({
    dataset: rawInvoices,
    producer: { kind: "sync", id: "erp" },
  })
  await merge.writeChanges([{ kind: "upsert", row: { id, title: `Invoice ${id}`, amount: "120" } }])
  await merge.commit()
}

let runs = 0

/** Runs the pipeline with a worker and returns the versions it wrote. */
async function run(host: SixbHost): Promise<Record<string, DatasetVersion>> {
  runs += 1
  const runId = `run-${runs}`
  const executionId = `exec:${runId}`
  await host.storage.executions.create({
    id: executionId,
    projectId: host.id,
    executor: { type: "primitive", kind: "pipeline", runId },
    source: { type: "schedule", eventId: `event:${runId}` },
    correlationId: `correlation:${runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "pipeline", id: "invoices", runId },
    },
  })
  await host.storage.pipelineRuns!.queue({
    id: runId,
    projectId: host.id,
    executionId,
    pipelineId: "invoices",
  })
  await host.queues.pipelines.enqueue({
    projectId: host.id,
    jobs: [{ id: runId, type: "pipeline.run.requested", payload: { runId } }],
  })
  const worker = new PipelineWorker(host)
  await worker.start()
  try {
    const startedAt = Date.now()
    for (;;) {
      const record = await host.storage.pipelineRuns!.getById({ projectId: host.id, id: runId })
      if (record?.status === "succeeded") break
      if (record?.status === "failed")
        throw new Error(`Pipeline run failed: ${record.error?.message}`)
      if (Date.now() - startedAt > 2_000) throw new Error("Timed out waiting for the run.")
      await Bun.sleep(10)
    }
  } finally {
    await worker.stop()
  }
  const written: Record<string, DatasetVersion> = {}
  for (const dataset of [normalized, history]) {
    const latest = await host.lakeStorage.getLatestVersion(dataset.id)
    if (latest) written[dataset.id] = latest
  }
  return written
}

/**
 * The columns an analyst without clearance does not receive, or `"rows"` when a marking decided
 * which rows the version holds, so the analyst cannot read them at all.
 */
async function redacted(host: SixbHost, dataset: DatasetDefinition) {
  const analyst = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "analyst" },
      groupIds: [analysts.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })
  try {
    const result = await analyst.datasets.readRows(dataset)
    return Object.keys(result?.redactions ?? {}).sort()
  } catch (error) {
    if (error instanceof AuthorizationError) return "rows"
    throw error
  }
}

/**
 * The lake after a cleanup that kept only the latest version of each dataset: every other
 * version is gone, and the classifier must not need it.
 */
function cleanedUp(lake: InMemoryLakeStorage): LakeStorage {
  const latestOnly = async (datasetId: string, versionId: string) => {
    const latest = await lake.getLatestVersion(datasetId)
    return latest?.versionId === versionId ? latest : null
  }
  return Object.assign(Object.create(lake) as InMemoryLakeStorage, {
    getVersion: latestOnly,
    listVersions: async (datasetId: string) => {
      const latest = await lake.getLatestVersion(datasetId)
      return latest ? [latest] : []
    },
  })
}

const refs = (...columns: readonly string[]) =>
  columns.map((ref) => {
    const [datasetId, column] = ref.split(".") as [string, string]
    return { datasetId, column }
  })

describe("resolved lineage through pipeline runs", () => {
  // Reproduce: in lineageAtCommit, return the written lineage for an append. The day-2 history
  // no longer lists `raw_invoices.amount`, and its columns read unmarked. Passing the step's own
  // lineage to beginWrite in executeRunStep, unresolved, fails the day-1 history instead.
  test("an append history keeps the markings of the rows it holds until rewritten", async () => {
    const lake = new InMemoryLakeStorage()

    // Day 1: titles are amounts.
    await sync(lake, "inv-1")
    const dayOne = deploy(lake, { title: "amount", historyMode: "append" })
    const first = await run(dayOne)
    expect(first.normalized?.lineage).toEqual({
      rows: refs("raw_invoices.amount", "raw_invoices.id"),
      columns: { id: [], title: [] },
    })
    expect(first.history?.lineage).toEqual({
      rows: refs("normalized.id", "normalized.title", "raw_invoices.amount", "raw_invoices.id"),
      columns: { id: [], title: [] },
    })

    // Day 2: the step is fixed. The normalized titles are readable again, but the history still
    // holds the day-1 rows.
    await sync(lake, "inv-2")
    const dayTwo = deploy(lake, { title: "title", historyMode: "append" })
    const second = await run(dayTwo)
    expect(second.history?.parentVersionId).toBe(first.history?.versionId)
    expect(second.history?.lineage).toEqual({
      rows: refs(
        "normalized.id",
        "normalized.title",
        "raw_invoices.amount",
        "raw_invoices.id",
        "raw_invoices.title"
      ),
      columns: { id: [], title: [] },
    })
    expect(await redacted(dayTwo, normalized)).toEqual([])
    expect(await redacted(dayTwo, history)).toBe("rows")

    // A cleanup that drops every earlier version changes nothing.
    const afterCleanup = deploy(cleanedUp(lake), { title: "title", historyMode: "append" })
    expect(await afterCleanup.lakeStorage.getVersion(history.id, first.history!.versionId)).toBe(
      null
    )
    expect(await redacted(afterCleanup, history)).toBe("rows")

    // Day 3: the history is rewritten in snapshot mode, from fixed titles only.
    const dayThree = deploy(lake, { title: "title", historyMode: "snapshot" })
    await run(dayThree)
    expect(await redacted(dayThree, history)).toEqual([])
  })
})
