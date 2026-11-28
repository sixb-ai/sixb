import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSnapshotLoadContractSuite, runSnapshotReadContractSuite } from "@sixb/core/testing"
import { migrateSqliteStorage, SqliteStorage } from "../src"
import { getSqliteStorageTestingAdapter } from "../src/testing"

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
runSnapshotLoadContractSuite("SQLite storage", fileStorage)

// Without a path, a branch is a database of its own in memory.
const memoryStorage = {
  createStorage: async () => new SqliteStorage(),
  cleanup: (storage: SqliteStorage) => storage.close(),
}
runSnapshotReadContractSuite("SQLite storage in memory", memoryStorage)
runSnapshotLoadContractSuite("SQLite storage in memory", memoryStorage)

// Reproduce: drop the `finally` that puts the settings back in SqliteStorage.loadSnapshot, and
// every later write skips its CHECK constraints and its flush.
test("a load puts back the settings it relaxes, even when it fails", async () => {
  const storage = new SqliteStorage()
  const db = getSqliteStorageTestingAdapter(storage).db
  const settings = () =>
    ["synchronous", "cache_size", "temp_store", "ignore_check_constraints"].map(
      (name) => Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, unknown>)[0]
    )

  try {
    const before = settings()
    const failure = new Error("the stream broke")
    const refused = await storage
      .loadSnapshot(
        {
          projectId: "settings",
          commit: {
            projectId: "settings",
            id: "snapshot_settings",
            idempotencyKey: "snapshot_settings",
            requestHash: "settings",
            executionId: "missing",
            origin: { kind: "runtime", requestId: "settings" },
            ontologyRevision: "settings",
            committedAt: "2026-01-01T00:00:00.000Z",
            intent: { kind: "edit", mode: "atomic", operationCount: 0 },
            result: {
              kind: "edit",
              commitId: "snapshot_settings",
              created: true,
              eventCount: 0,
              committedAt: "2026-01-01T00:00:00.000Z",
              outcomes: [],
              changes: { objects: [], links: [] },
            },
          },
          uniqueProperties: [],
          objectTypeIds: [],
        },
        async () => {
          throw failure
        }
      )
      .catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(Error)
    expect(settings()).toEqual(before)
  } finally {
    storage.close()
  }
})

// Red check: in readSqliteLinkEdits, leave legacy slots in the query and drop them after it: a
// page of them comes back empty, and the export stops reading link edits there.
test("a page of slots an old migration left in conflict does not end the link edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-legacy-slots-"))
  try {
    await migrateSqliteStorage(directory)
    const storage = new SqliteStorage({ path: directory })
    const db = new Database(join(directory, "storage.sqlite"))
    const slot = db.prepare(
      `INSERT INTO ontology_link_overrides (project_id, identity_kind, identity_key, source_type_id,
         source_primary_id, link_id, target_type_id, target_primary_id, value, last_commit_id,
         updated_at)
       VALUES ('p', 'slot', ?, 'Thing', ?, 'owner', 'Thing', 'x', ?, 'c', '2026-01-01T00:00:00.000Z')`
    )
    for (const [id, kind] of [
      ["a", "legacy-conflict"],
      ["b", "legacy-conflict"],
      ["c", "legacy-conflict"],
      ["d", "clear"],
    ] as const) {
      slot.run(
        JSON.stringify(["Thing", id, "owner"]),
        id,
        JSON.stringify(
          kind === "clear" ? { kind, target: { objectTypeId: "Thing", primaryId: "x" } } : { kind }
        )
      )
    }
    db.close()

    const page = await storage.readSnapshot({ views: 1, maxDurationMs: 60_000 }, ([view]) =>
      view!.readLinkEdits({ projectId: "p", sourceTypeId: "Thing", limit: 3 })
    )
    expect(page.map((edit) => (edit.kind === "slot" ? edit.source.primaryId : ""))).toEqual(["d"])
    storage.close()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// Reproduce: drop the namespace check of SqliteStorage.unloadSnapshot, and a root database loses
// whatever it holds.
test("a load is emptied in a branch namespace only", async () => {
  const storage = new SqliteStorage()
  try {
    const refused = await storage
      .unloadSnapshot({ projectId: "p", commitId: "snapshot_1" })
      .catch((error: Error) => error)
    expect(String(refused)).toContain(
      "[SixbSqlite] A snapshot load is emptied in a branch namespace only"
    )
  } finally {
    storage.close()
  }
})
