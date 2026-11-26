import {
  col,
  type DatasetDefinition,
  defineDataset,
  defineObjectType,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeMaintenanceOptions,
  prop,
  SixbHost,
} from "@sixb/core"
import {
  type LakeMaintenance,
  type LakeRetentionOptions,
  type LakeRetentionReport,
  LakeStorageError,
} from "@sixb/core/lake-storage"
import type { SyncRunRecord } from "@sixb/core/storage"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const things = defineDataset("raw.things", {
  schema: [col("id", "string", { nullable: true })],
})

/** How the next host is built, and what its providers were asked. lake.test.ts resets it. */
export const lakeFixture = {
  drift: false,
  maintenance: true,
  lakeMaintenance: undefined as LakeMaintenanceOptions | undefined,
  /** Whether storage says the orchestrator asks for retention, with no worker answering. */
  unansweredRequest: false,
  /** Whether a dataset's changes wait in the inbox with nothing writing them. */
  stalledIngest: false,
  /** Whether a run lost its job, and a week-old one with it. */
  lostRuns: false,
  /** How many retention passes report more to clean up before one reports none. */
  retentionPassesWithMore: 0,
  /** A dataset version a projection applied, or "unreadable" when reading them fails. */
  appliedVersion: undefined as string | undefined,
  /** A row a flush refused, kept with what it would take to send it again. */
  rejectedRow: undefined as Record<string, unknown> | undefined,
  events: [] as Record<string, unknown>[],
}

// Mirrors the real lake drift failure without needing a Postgres-backed catalog:
// the command path is what these tests exercise, not the diff algorithm itself.
class FixtureLakeStorage extends InMemoryLakeStorage {
  override async assertDatasetDefinitionsCompatible(
    definitions: readonly DatasetDefinition[]
  ): Promise<void> {
    if (lakeFixture.drift) {
      const datasetId = definitions[0]?.id ?? "unknown"
      throw new LakeStorageError(
        `[SixbLake] Lake dataset definition check failed for 1 dataset(s).\n- ${datasetId}: dataset '${datasetId}' has drifted from the lake catalog`
      )
    }
    return super.assertDatasetDefinitionsCompatible(definitions)
  }

  async close(): Promise<void> {
    lakeFixture.events.push({ type: "lake-storage:close" })
  }
}

class MaintenanceLakeStorage extends FixtureLakeStorage {
  readonly maintenance: LakeMaintenance = {
    async applyRetention(options?: LakeRetentionOptions): Promise<LakeRetentionReport> {
      lakeFixture.events.push({ type: "lake:retention", ...options })
      const passes = lakeFixture.events.filter((event) => event.type === "lake:retention").length

      return {
        dryRun: options?.dryRun ?? false,
        keepVersionsForMs: options?.keepVersionsForMs ?? 0,
        deleteFilesAfterMs: options?.deleteFilesAfterMs ?? 0,
        expiredVersions: 2,
        keptVersions: 5,
        deletedFiles: 3,
        orphanedFiles: 4,
        hasMore: passes <= lakeFixture.retentionPassesWithMore,
      }
    },

    async describeStorage() {
      return []
    },
  }
}

function unansweredBeat() {
  const now = new Date()

  return {
    projectId: "cli-lake-project",
    owner: "orchestrator" as const,
    beatAt: now,
    everyMs: 30_000,
    passes: [{ id: "lake-retention", lastSucceededAt: now, consecutiveFailures: 0 }],
  }
}

/** What a flush that refuses the row's delivery leaves behind. */
async function refuse(storage: InMemoryStorage, row: Record<string, unknown>): Promise<void> {
  const inbox = storage.datasetIngest
  const place = { projectId: "cli-lake-project", datasetId: things.id }
  const { delivery } = await inbox.append({
    ...place,
    executionId: "exec-1",
    correlationId: "corr-1",
    definitionHash: "definition-1",
    changes: [{ kind: "upsert", row }],
  })

  const held = await inbox.acquire({ ...place, owner: "fixture", leaseMs: 60_000 })
  if (!held.acquired) throw new Error("[Fixture] Expected to hold the dataset.")

  await inbox.takeBatch({ lease: held.lease, flushId: "flush-1", maxChanges: 10 })
  await inbox.reject({
    lease: held.lease,
    flushId: "flush-1",
    deliveryId: delivery.id,
    reason: "Refused by the fixture.",
  })
}

function ago(ms: number): Date {
  return new Date(Date.now() - ms)
}

function stallIngest(storage: InMemoryStorage): void {
  storage.datasetIngest.summarize = async () => [
    {
      datasetId: things.id,
      pendingDeliveries: 2,
      pendingChanges: 2,
      oldestReceivedAt: ago(60 * 60_000),
      flushStartedAt: null,
      request: 1,
      leaseExpiresAt: null,
      failureStreak: 0,
      lastFlushedAt: null,
      rejectedDeliveries: 0,
    },
  ]
}

function loseRuns(storage: InMemoryStorage): void {
  const lostRun = (id: string, queuedAt: Date) =>
    ({ id, status: "queued", attempt: 0, queuedAt }) as SyncRunRecord

  storage.syncRuns.listLost = async () => [
    lostRun("lost", ago(60 * 60_000)),
    lostRun("stale", ago(8 * 24 * 60 * 60_000)),
  ]
}

function createStorage(): InMemoryStorage {
  const storage = new InMemoryStorage()
  if (lakeFixture.unansweredRequest) void storage.maintenanceHeartbeats.record(unansweredBeat())
  if (lakeFixture.stalledIngest) stallIngest(storage)
  if (lakeFixture.lostRuns) loseRuns(storage)

  const rejectedRow = lakeFixture.rejectedRow
  if (rejectedRow) {
    const listRejected = storage.datasetIngest.listRejected.bind(storage.datasetIngest)
    storage.datasetIngest.listRejected = async (input) => {
      await refuse(storage, rejectedRow)
      return listRejected(input)
    }
  }

  const versionId = lakeFixture.appliedVersion
  if (!versionId) return storage

  // Stands for a projection that applied a dataset version: what cleanup must keep.
  storage.ontology.sources.listActive = async () => {
    if (versionId === "unreadable") throw new Error("ontology storage is unreachable")

    return [
      {
        source: { projectionId: "rooms" },
        projectionKind: "object",
        datasetVersion: { datasetId: things.id, versionId, createdAt: "2026-10-10T00:00:00.000Z" },
        projectionRevision: "revision",
        ontologyRevision: "ontology",
        activatedAt: "2026-10-10T00:00:00.000Z",
      },
    ]
  }
  return storage
}

// A factory, so every command lake.test.ts runs in its process loads a host built from the
// configuration above.
export function sixb(): SixbHost {
  return new SixbHost({
    id: "cli-lake-project",
    ontology: [Room],
    broker: new InMemoryBroker(),
    storage: createStorage(),
    lakeStorage: lakeFixture.maintenance ? new MaintenanceLakeStorage() : new FixtureLakeStorage(),
    lakeMaintenance: lakeFixture.lakeMaintenance,
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [things],
  })
}
