import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runOntologyMigrationContractSuite } from "@sixb/core/testing"
import { migrateSqliteStorage, SqliteStorage } from "../src"

const directories = new WeakMap<SqliteStorage, string>()

// A file, as a project runs on, and a database in memory, as `sixb dev` may.
runOntologyMigrationContractSuite("SQLite storage", {
  createStorage: async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrations-"))
    await migrateSqliteStorage(directory)

    const storage = new SqliteStorage({ path: directory })
    directories.set(storage, directory)
    return storage
  },
  cleanup: async (storage) => {
    storage.close()
    const directory = directories.get(storage)
    if (directory) await rm(directory, { recursive: true, force: true })
  },
})

runOntologyMigrationContractSuite("SQLite storage in memory", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})
