import { describe, expect, test } from "bun:test"
import type { DatasetRow } from "@sixb/core"
import {
  col,
  defineConnector,
  defineDataset,
  defineSync,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryStorage,
  type SyncDefinition,
} from "@sixb/core"
import type { SyncConnectorSource, SyncConnectorSourceResolver } from "@sixb/core/internal/syncs"
import type { ExecutionStorage } from "@sixb/core/storage"
import { runSyncJob as runSyncJobWithDurableRun } from "../src/run-sync-job"
import type { SyncWorkerContext } from "../src/types"

const social = defineConnector("social", {
  type: "social-oauth",
  authentication: {
    type: "oauth2",
    authorizationUrl() {
      return "https://provider.test/oauth"
    },
    exchangeCode() {
      return { accessToken: "access" }
    },
    refresh() {
      return { accessToken: "refreshed" }
    },
  },
  discoverAccounts() {
    return []
  },
  connect(context) {
    return { accountId: context.account.id }
  },
})

const socialRows = defineDataset("raw.social.rows", {
  schema: [col("id", "string"), col("accountId", "string", { nullable: true })],
})

interface ManagedSyncFixture {
  readonly runtime: SyncWorkerContext
  readonly executions: ExecutionStorage
  readonly lakeStorage: InMemoryLakeStorage
}

function createFixture(
  sync: SyncDefinition,
  sources: () => readonly SyncConnectorSource[]
): ManagedSyncFixture {
  const storage = new InMemoryStorage()
  const connectorSources: SyncConnectorSourceResolver = {
    async list() {
      return sources() as never
    },
  }
  const lakeStorage = new InMemoryLakeStorage()
  return {
    executions: storage.executions,
    lakeStorage,
    runtime: {
      id: "project-1",
      syncRunsStorage: storage.syncRuns,
      lakeStorage,
      blobs: new InMemoryBlobStorage(),
      datasets: {
        getById(datasetId) {
          return datasetId === sync.target.dataset.id ? sync.target.dataset : null
        },
      },
      syncs: {
        getById(syncId) {
          return syncId === sync.id ? sync : null
        },
      },
      connectorSources,
    },
  }
}

function source(connectionId: string, accountId: string, slot: string): SyncConnectorSource {
  return {
    connection: {
      id: connectionId,
      connectorId: social.id,
      owner: { type: "project" },
      slot,
      account: { id: accountId, label: accountId },
    },
    async connect() {
      return { accountId }
    },
  }
}

async function run(fixture: ManagedSyncFixture, syncId: string, runId: string) {
  const sync = fixture.runtime.syncs.getById(syncId)
  if (!sync) throw new Error(`[Test] Unknown Sync '${syncId}'.`)
  const executionId = `exec:${runId}`
  await fixture.executions.create({
    id: executionId,
    projectId: fixture.runtime.id,
    executor: { type: "primitive", kind: "sync", runId },
    source: { type: "schedule", eventId: `event:${runId}` },
    correlationId: `correlation:${runId}`,
    authorizationRef: {
      type: "trustedPrimitive",
      primitive: { kind: "sync", id: sync.id, runId },
    },
  })
  const queued = await fixture.runtime.syncRunsStorage.queue({
    id: runId,
    projectId: fixture.runtime.id,
    executionId,
    syncId: sync.id,
    datasetId: sync.target.dataset.id,
    mode: sync.config.mode,
  })
  return runSyncJobWithDurableRun({ runtime: fixture.runtime, run: queued })
}

async function rows(storage: InMemoryLakeStorage): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of storage.readRows({ datasetId: socialRows.id })) {
    result.push(row)
  }
  return result
}

describe("managed connector Sync fan-out", () => {
  test("reads every connection into one snapshot and clears it when none remain", async () => {
    const seen: string[] = []
    const sync = defineSync("sync-social-accounts")
      .from(social)
      .read((client, context) => {
        seen.push(context.connection.id)
        return {
          id: `${context.connection.id}:row`,
          accountId: client.accountId,
        }
      })
      .intoDataset(socialRows)
    let sources = [
      source("connection-b", "account-b", "brand-b"),
      source("connection-a", "account-a", "brand-a"),
    ]
    const fixture = createFixture(sync, () => sources)

    const result = await run(fixture, sync.id, "run-managed")
    expect(result.rowsRead).toBe(2)
    expect(seen).toEqual(["connection-a", "connection-b"])
    expect(await rows(fixture.lakeStorage)).toEqual([
      { id: "connection-a:row", accountId: "account-a" },
      { id: "connection-b:row", accountId: "account-b" },
    ])

    sources = []
    const empty = await run(fixture, sync.id, "run-managed-empty")
    expect(empty.rowsRead).toBe(0)
    expect(await rows(fixture.lakeStorage)).toEqual([])
  })

  test("isolates checkpoints and resets only a replaced account", async () => {
    const seen: {
      connectionId: string
      accountId: string
      checkpoint: string | undefined
    }[] = []
    const nextCursor = new Map<string, string>()
    const sync = defineSync("sync-social-checkpoints", { mode: "append" })
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((client, context) => {
        seen.push({
          connectionId: context.connection.id,
          accountId: client.accountId,
          checkpoint: context.checkpoint?.cursor,
        })
        const cursor = nextCursor.get(context.connection.id)
        if (!cursor) throw new Error("Missing test cursor.")
        context.setCheckpoint({ cursor })
        return { id: `${context.connection.id}:${cursor}` }
      })
      .intoDataset(socialRows)
    let sources: readonly SyncConnectorSource[] = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    const fixture = createFixture(sync, () => sources)

    nextCursor.set("connection-a", "a-1")
    nextCursor.set("connection-b", "b-1")
    await run(fixture, sync.id, "run-checkpoints-1")

    sources = [source("connection-a", "account-a", "brand-a")]
    nextCursor.set("connection-a", "a-2")
    await run(fixture, sync.id, "run-checkpoints-2")

    sources = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    nextCursor.set("connection-a", "a-3")
    nextCursor.set("connection-b", "b-2")
    await run(fixture, sync.id, "run-checkpoints-3")

    sources = [
      source("connection-a", "account-c", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    nextCursor.set("connection-a", "c-1")
    nextCursor.set("connection-b", "b-3")
    await run(fixture, sync.id, "run-checkpoints-4")

    expect(seen).toEqual([
      { connectionId: "connection-a", accountId: "account-a", checkpoint: undefined },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: undefined },
      { connectionId: "connection-a", accountId: "account-a", checkpoint: "a-1" },
      { connectionId: "connection-a", accountId: "account-a", checkpoint: "a-2" },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: "b-1" },
      { connectionId: "connection-a", accountId: "account-c", checkpoint: undefined },
      { connectionId: "connection-b", accountId: "account-b", checkpoint: "b-2" },
    ])
  })

  test("preserves the previous dataset and checkpoints when one source fails", async () => {
    let generation = "initial"
    let failConnectionB = false
    const sync = defineSync("sync-social-atomic")
      .checkpoint<{ cursor: string }>()
      .from(social)
      .read((client, context) => {
        if (failConnectionB && context.connection.id === "connection-b") {
          throw new Error("provider unavailable")
        }
        context.setCheckpoint({ cursor: `${client.accountId}:${generation}` })
        return {
          id: `${context.connection.id}:${generation}`,
          accountId: client.accountId,
        }
      })
      .intoDataset(socialRows)
    const sources = [
      source("connection-a", "account-a", "brand-a"),
      source("connection-b", "account-b", "brand-b"),
    ]
    const fixture = createFixture(sync, () => sources)

    await run(fixture, sync.id, "run-atomic-1")
    const initialRows = await rows(fixture.lakeStorage)
    const firstRun = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-atomic-1",
    })

    generation = "next"
    failConnectionB = true
    await expect(run(fixture, sync.id, "run-atomic-2")).rejects.toThrow("provider unavailable")

    expect(await rows(fixture.lakeStorage)).toEqual(initialRows)
    const failedRun = await fixture.runtime.syncRunsStorage.getById({
      projectId: fixture.runtime.id,
      id: "run-atomic-2",
    })
    expect(failedRun).toMatchObject({
      status: "failed",
      checkpoint: undefined,
      error: {
        code: "sync.execution_failed",
        details: {
          connectionId: "connection-b",
          accountId: "account-b",
        },
      },
    })
    expect(firstRun?.checkpoint).toBeDefined()
  })
})
