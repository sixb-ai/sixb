import { expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetProducer,
  type DatasetVersionRef,
  defineDataset,
  InMemoryLakeStorage,
  InMemoryStorage,
} from "@sixb/core"
import { startTestSyncRun } from "@sixb/core/testing"
import { resolveSourceReadAt } from "../src/source-read-time"

const PROJECT = "source-read-time"
const customers = defineDataset("customers", { schema: [col("id", "string")] })
const invoices = defineDataset("invoices", { schema: [col("id", "string")] })
const joined = defineDataset("customer_invoices", { schema: [col("id", "string")] })

function fixture() {
  const lake = new InMemoryLakeStorage()
  const storage = new InMemoryStorage()

  /** Writes a version of `dataset`, from `inputs` when it has any. */
  const write = async (
    dataset: DatasetDefinition,
    producer: DatasetProducer,
    inputs?: readonly DatasetVersionRef[]
  ) => {
    await lake.createDataset(dataset)
    const writer = await lake.beginWrite({
      dataset,
      mode: "snapshot",
      producer,
      ...(inputs ? { inputs } : {}),
    })
    await writer.writeRows([{ id: "a" }])
    return writer.commit({ commitMessage: "read time fixture" })
  }

  /** Writes a version as the sync run `runId` would, which started at `startedAt`. */
  const sync = async (dataset: DatasetDefinition, runId: string, startedAt: string) => {
    await startTestSyncRun(storage, {
      id: runId,
      projectId: PROJECT,
      syncId: dataset.id,
      datasetId: dataset.id,
      mode: "snapshot",
      startedAt: new Date(startedAt),
    })
    return write(dataset, { kind: "sync", id: dataset.id, runId })
  }

  const readAt = (version: Parameters<typeof resolveSourceReadAt>[0]["version"]) =>
    resolveSourceReadAt({
      projectId: PROJECT,
      version,
      lakeStorage: lake,
      syncRuns: storage.syncRuns,
    })

  return { lake, storage, write, sync, readAt }
}

test("a synced version was read when its sync run started", async () => {
  const { sync, readAt } = fixture()

  const version = await sync(customers, "customers-sync", "2026-05-01T10:00:00.000Z")

  expect(await readAt(version)).toBe("2026-05-01T10:00:00.000Z")
})

test("a pipeline version is only as recent as the earliest read among its inputs", async () => {
  const { write, sync, readAt } = fixture()
  const fresh = await sync(customers, "customers-sync", "2026-05-01T10:00:00.000Z")
  const stale = await sync(invoices, "invoices-sync", "2026-05-01T08:00:00.000Z")

  const version = await write(joined, { kind: "pipeline", id: "join", runId: "join-run" }, [
    fresh,
    stale,
  ])

  expect(await readAt(version)).toBe("2026-05-01T08:00:00.000Z")
})

test("a read time is unknown as soon as one input cannot tell", async () => {
  const { lake, storage, write, sync, readAt } = fixture()
  const synced = await sync(customers, "customers-sync", "2026-05-01T10:00:00.000Z")
  const ingested = await write(invoices, { kind: "ingest", id: "webhook-execution" })
  const forgotten = await write(invoices, { kind: "sync", id: "invoices", runId: "purged-run" })
  const join = (input: DatasetVersionRef) =>
    write(joined, { kind: "pipeline", id: "join", runId: `join-${input.versionId}` }, [
      synced,
      input,
    ])

  // Ingested rows were not read from a source at one instant.
  expect(await readAt(await join(ingested))).toBeUndefined()

  // Run storage no longer holds the run that wrote an input.
  expect(await readAt(await join(forgotten))).toBeUndefined()

  // The lake no longer holds an input version.
  const copy = await write(joined, { kind: "pipeline", id: "copy", runId: "copy-run" }, [synced])
  expect(await readAt(copy)).toBe("2026-05-01T10:00:00.000Z")
  expect(
    await resolveSourceReadAt({
      projectId: PROJECT,
      version: copy,
      lakeStorage: {
        getVersion: async (datasetId, versionId) =>
          versionId === synced.versionId ? null : lake.getVersion(datasetId, versionId),
      },
      syncRuns: storage.syncRuns,
    })
  ).toBeUndefined()
})
