import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
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

function withDatabase<T>(path: string, run: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return run(db)
  } finally {
    db.close()
  }
}
