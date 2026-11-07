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
  prop,
  SixbHost,
} from "@sixb/core"
import {
  type LakeMaintenance,
  type LakeRetentionOptions,
  type LakeRetentionReport,
  LakeStorageError,
} from "@sixb/core/lake-storage"

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
  /** How many retention passes report more to clean up before one reports none. */
  retentionPassesWithMore: 0,
  /** A dataset version a projection applied, or "unreadable" when reading them fails. */
  appliedVersion: undefined as string | undefined,
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

function createStorage(): InMemoryStorage {
  const storage = new InMemoryStorage()
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
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [things],
  })
}
