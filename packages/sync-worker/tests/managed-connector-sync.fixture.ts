import type { DatasetRow, JsonValue, SyncDefinition } from "@sixb/core"
import {
  col,
  defineConnector,
  defineDataset,
  InMemoryBlobStorage,
  InMemoryLakeStorage,
  InMemoryStorage,
} from "@sixb/core"
import type { SyncConnectorSource, SyncConnectorSourceResolver } from "@sixb/core/internal/syncs"
import type { ExecutionStorage } from "@sixb/core/storage"
import { runSyncJob as runSyncJobWithDurableRun } from "../src/run-sync-job"
import type { SyncWorkerContext } from "../src/types"

export const social = defineConnector("social", {
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

export const socialRows = defineDataset("raw.social.rows", {
  schema: [col("id", "string"), col("accountId", "string", { nullable: true })],
})

export interface ManagedSyncFixture {
  readonly runtime: SyncWorkerContext
  readonly executions: ExecutionStorage
  readonly lakeStorage: InMemoryLakeStorage
}

export function createFixture(
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

export function source(connectionId: string, accountId: string, slot: string): SyncConnectorSource {
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

export async function run(
  fixture: ManagedSyncFixture,
  syncId: string,
  runId: string,
  signal?: AbortSignal
) {
  const queued = await queueRun(fixture, syncId, runId)
  return runSyncJobWithDurableRun({
    runtime: fixture.runtime,
    run: queued,
    ...(signal === undefined ? {} : { signal }),
  })
}

export async function seedSuccessfulCheckpoint(
  fixture: ManagedSyncFixture,
  syncId: string,
  runId: string,
  checkpoint: JsonValue
): Promise<void> {
  const queued = await queueRun(fixture, syncId, runId)
  await fixture.runtime.syncRunsStorage.start({
    projectId: fixture.runtime.id,
    id: queued.id,
  })
  await fixture.runtime.syncRunsStorage.finish({
    projectId: fixture.runtime.id,
    id: queued.id,
    status: "succeeded",
    rowsRead: 0,
    checkpoint,
  })
}

export async function rows(storage: InMemoryLakeStorage): Promise<DatasetRow[]> {
  const result: DatasetRow[] = []
  for await (const row of storage.readRows({ datasetId: socialRows.id })) {
    result.push(row)
  }
  return result
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for managed Sync state.")
}

async function queueRun(fixture: ManagedSyncFixture, syncId: string, runId: string) {
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
  return fixture.runtime.syncRunsStorage.queue({
    id: runId,
    projectId: fixture.runtime.id,
    executionId,
    syncId: sync.id,
    datasetId: sync.target.dataset.id,
    mode: sync.config.mode,
  })
}
