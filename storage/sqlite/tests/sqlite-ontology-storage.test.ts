import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import type { MaterializationPlanHeader, MaterializationWorkRecord } from "@sixb/core/storage"
import {
  runMaterializationFailureContractSuite,
  runOntologyStorageContractSuite,
  runProjectionRunStorageContractSuite,
} from "@sixb/core/testing"
import { SqliteStorage } from "../src"
import { sqliteStoragePath } from "../src/migrations"
import { SqliteProjectionRunStorage } from "../src/projection-run-storage"

runOntologyStorageContractSuite("SQLite ontology storage contract", {
  createStorage: () => new SqliteStorage(),
  cleanup(storage) {
    storage.close()
  },
})

test("SQLite work staging rolls back a partial batch after a later record conflicts", async () => {
  const storage = new SqliteStorage()
  const header = atomicStageHeader()
  const first = classificationWork("first")
  const pending = classificationWork("pending")
  try {
    await storage.transaction(async (tx) => {
      const materializations = tx.ontology.materializations
      const session = await materializations.begin(header)
      await materializations.stageWork({ session, records: [first] })
      await expect(
        materializations.stageWork({ session, records: [pending, first] })
      ).rejects.toThrow("Duplicate materialization work key 'classification:first'.")

      // The valid first row from the rejected batch must not remain staged.
      await expect(
        materializations.stageWork({ session, records: [pending] })
      ).resolves.toBeUndefined()
      await materializations.finalize({
        session,
        finalization: {
          sourceActivations: [],
          result: {
            kind: "edit",
            commitId: header.commit.id,
            created: true,
            eventCount: 0,
            committedAt: header.commit.committedAt,
            outcomes: [],
            changes: { objects: [], links: [] },
          },
        },
      })
    })
  } finally {
    storage.close()
  }
})

runProjectionRunStorageContractSuite("SQLite projection-run storage contract", {
  createStorage: () => new SqliteProjectionRunStorage(),
  cleanup(storage) {
    storage.close()
  },
})

interface FailureStorage extends SqliteStorage {
  readonly testDirectory: string
  readonly testDatabasePath: string
}

runMaterializationFailureContractSuite("SQLite materialization failure contract", {
  async createStorage(): Promise<FailureStorage> {
    const testDirectory = await mkdtemp(join(tmpdir(), "sixb-sqlite-ontology-failure-"))
    const storage = new SqliteStorage({ path: testDirectory }) as FailureStorage
    Object.defineProperties(storage, {
      testDirectory: { value: testDirectory },
      testDatabasePath: { value: sqliteStoragePath(testDirectory) },
    })
    await migrateStorage(storage)
    return storage
  },
  cleanup: async (storage) => {
    storage.close()
    await rm(storage.testDirectory, { recursive: true, force: true })
  },
  captureState(storage) {
    return withDatabase(storage.testDatabasePath, (db) => ({
      objects: db
        .query("SELECT * FROM objects ORDER BY project_id, object_type_id, primary_id")
        .all(),
      commits: db.query("SELECT * FROM ontology_commits ORDER BY project_id, id").all(),
      outbox: db.query("SELECT * FROM ontology_outbox ORDER BY project_id, id").all(),
    }))
  },
  injectFailure(storage, boundary, failure) {
    const table =
      boundary === "effective.object.upsert"
        ? "objects"
        : boundary === "outbox.insert"
          ? "ontology_outbox"
          : "ontology_commits"
    withDatabase(storage.testDatabasePath, (db) => {
      db.run(`
        CREATE TRIGGER ontology_contract_failure
        BEFORE INSERT ON ${table}
        BEGIN
          SELECT RAISE(ABORT, '${failure.message.replaceAll("'", "''")}');
        END
      `)
    })
  },
  clearFailure(storage) {
    withDatabase(storage.testDatabasePath, (db) => {
      db.run("DROP TRIGGER IF EXISTS ontology_contract_failure")
    })
  },
})

function atomicStageHeader(): MaterializationPlanHeader {
  return {
    commit: {
      projectId: "contract-project",
      id: "atomic-work-stage",
      idempotencyKey: "runtime:atomic-work-stage",
      requestHash: "hash:atomic-work-stage",
      origin: { kind: "runtime", requestId: "atomic-work-stage" },
      ontologyRevision: "ontology-contract-revision",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: "2026-01-02T00:00:00.000Z",
    },
    expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
  }
}

function classificationWork(id: string): MaterializationWorkRecord {
  return {
    kind: "classification",
    recordKey: `classification:${id}`,
    entityKind: "object",
    identityKey: `["ContractDevice","${id}"]`,
  }
}

function withDatabase<T>(path: string, run: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}
