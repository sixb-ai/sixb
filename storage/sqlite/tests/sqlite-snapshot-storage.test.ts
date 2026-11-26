import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSnapshotReadContractSuite } from "@sixb/core/testing"
import { migrateSqliteStorage, SqliteStorage } from "../src"

const directories = new WeakMap<SqliteStorage, string>()

const fileStorage = {
  createStorage: async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-snapshot-"))
    await migrateSqliteStorage(directory)

    const storage = new SqliteStorage({ path: directory })
    directories.set(storage, directory)
    return storage
  },
  cleanup: async (storage: SqliteStorage) => {
    storage.close()
    const directory = directories.get(storage)
    if (directory) await rm(directory, { recursive: true, force: true })
  },
}

// A file, because a branch is a file of its own beside it.
runSnapshotReadContractSuite("SQLite storage", fileStorage)

// Without a path, a branch is a database of its own in memory.
const memoryStorage = {
  createStorage: async () => new SqliteStorage(),
  cleanup: (storage: SqliteStorage) => storage.close(),
}
runSnapshotReadContractSuite("SQLite storage in memory", memoryStorage)
