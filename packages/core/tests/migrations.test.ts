import { describe, expect, test } from "bun:test"
import {
  defineMigrations,
  InMemoryStorage,
  type MigrationHistoryStore,
  type MigrationRecord,
  migrateStorage,
  runMigrationSet,
  type StorageMigrator,
  step,
} from "../src"

interface FakeStorageDb {
  tables: Set<string>
  columnsByTable: Map<string, Set<string>>
  operations: string[]
}

function createFakeStorageDb(): FakeStorageDb {
  return {
    tables: new Set(),
    columnsByTable: new Map(),
    operations: [],
  }
}

function ensureTable(db: FakeStorageDb, tableName: string, columns: readonly string[] = []): void {
  db.tables.add(tableName)
  const existingColumns = db.columnsByTable.get(tableName) ?? new Set<string>()
  for (const column of columns) {
    existingColumns.add(column)
  }
  db.columnsByTable.set(tableName, existingColumns)
}

function addColumn(db: FakeStorageDb, tableName: string, column: string): void {
  ensureTable(db, tableName)
  db.columnsByTable.get(tableName)?.add(column)
}

function getTableColumns(db: FakeStorageDb, tableName: string): string[] {
  return [...(db.columnsByTable.get(tableName) ?? new Set<string>())].sort()
}

function createMigrationHarness(initialRows: readonly MigrationRecord[] = []) {
  const db = createFakeStorageDb()
  const rows = [...initialRows]
  let time = 0

  const state: MigrationHistoryStore = {
    ensure() {
      ensureTable(db, "sixb_migrations", [
        "adapter_id",
        "version",
        "id",
        "checksum",
        "status",
        "started_at",
        "finished_at",
      ])
    },
    readHistory(adapterId) {
      return rows.filter((row) => row.adapterId === adapterId)
    },
    markStarted(adapterId, migration, at) {
      rows.push({
        adapterId,
        version: migration.version,
        id: migration.id,
        checksum: migration.checksum,
        status: "started",
        startedAt: at,
      })
    },
    markApplied(adapterId, migration, at) {
      const row = rows.find(
        (item) => item.adapterId === adapterId && item.version === migration.version
      )
      if (!row) throw new Error("missing started row")
      rows[rows.indexOf(row)] = {
        ...row,
        status: "applied",
        finishedAt: at,
      }
    },
    async transaction<T>(run: () => Promise<T>) {
      db.operations.push("tx:start")
      const result = await run()
      db.operations.push("tx:commit")
      return result
    },
  }

  return {
    db,
    rows,
    state,
    now() {
      time += 1
      return `2026-04-19T00:00:0${time}.000Z`
    },
  }
}

function appliedRow(version: number, id: string, checksum?: string): MigrationRecord {
  return {
    adapterId: "SixbFakeStorage",
    version,
    id,
    checksum,
    status: "applied",
    startedAt: "2026-04-19T00:00:00.000Z",
    finishedAt: "2026-04-19T00:00:01.000Z",
  }
}

describe("runMigrationSet", () => {
  test("applies pending schema changes and records migration history", async () => {
    const harness = createMigrationHarness()
    const migrations = defineMigrations({
      adapterId: "SixbFakeStorage",
      steps: [
        step<FakeStorageDb>("001-create-objects", (db) => {
          ensureTable(db, "objects", ["project_id", "object_type_id", "primary_id"])
        }),
        step<FakeStorageDb>("002-add-source-event-id", (db) => {
          addColumn(db, "objects", "source_event_id")
        }),
      ],
    })

    const report = await runMigrationSet({
      context: harness.db,
      migrations,
      state: harness.state,
      now: harness.now,
    })

    expect([...harness.db.tables].sort()).toEqual(["objects", "sixb_migrations"])
    expect(getTableColumns(harness.db, "objects")).toEqual([
      "object_type_id",
      "primary_id",
      "project_id",
      "source_event_id",
    ])
    expect(harness.rows.map((row) => [row.version, row.id, row.status])).toEqual([
      [1, "001-create-objects", "applied"],
      [2, "002-add-source-event-id", "applied"],
    ])
    expect(harness.db.operations).toEqual(["tx:start", "tx:commit", "tx:start", "tx:commit"])
    expect(report).toEqual({
      adapterId: "SixbFakeStorage",
      latestVersion: 2,
      status: "migrated",
      applied: ["001-create-objects", "002-add-source-event-id"],
      skipped: [],
    })
  })

  test("skips already-applied migrations and only applies pending steps", async () => {
    const harness = createMigrationHarness([appliedRow(1, "001-create-objects")])
    ensureTable(harness.db, "objects", ["project_id", "object_type_id", "primary_id"])
    const migrations = defineMigrations({
      adapterId: "SixbFakeStorage",
      steps: [
        step<FakeStorageDb>("001-create-objects", () => {
          throw new Error("version 1 should not run again")
        }),
        step<FakeStorageDb>("002-add-source-event-id", (db) => {
          addColumn(db, "objects", "source_event_id")
        }),
      ],
    })

    const report = await runMigrationSet({
      context: harness.db,
      migrations,
      state: harness.state,
      now: harness.now,
    })

    expect(getTableColumns(harness.db, "objects")).toEqual([
      "object_type_id",
      "primary_id",
      "project_id",
      "source_event_id",
    ])
    expect(harness.rows.map((row) => [row.version, row.id, row.status])).toEqual([
      [1, "001-create-objects", "applied"],
      [2, "002-add-source-event-id", "applied"],
    ])
    expect(report.applied).toEqual(["002-add-source-event-id"])
    expect(report.skipped).toEqual(["001-create-objects"])
  })

  test("fails fast on dirty migration history", async () => {
    const harness = createMigrationHarness([
      {
        ...appliedRow(1, "001-create-objects"),
        status: "started",
        finishedAt: undefined,
      },
    ])

    await expect(
      runMigrationSet({
        context: harness.db,
        migrations: defineMigrations({
          adapterId: "SixbFakeStorage",
          steps: [step<FakeStorageDb>("001-create-objects", () => {})],
        }),
        state: harness.state,
      })
    ).rejects.toThrow("dirty migration state")
  })

  test("fails when the database schema is newer than the code", async () => {
    const harness = createMigrationHarness([appliedRow(1, "001-create-objects")])

    await expect(
      runMigrationSet({
        context: harness.db,
        migrations: defineMigrations({
          adapterId: "SixbFakeStorage",
          steps: [],
        }),
        state: harness.state,
      })
    ).rejects.toThrow("Database schema is newer than this Sixb version")
  })

  test("fails when an applied migration checksum changes", async () => {
    const harness = createMigrationHarness([appliedRow(1, "001-create-objects", "old")])

    await expect(
      runMigrationSet({
        context: harness.db,
        migrations: defineMigrations({
          adapterId: "SixbFakeStorage",
          steps: [step<FakeStorageDb>("001-create-objects", () => {}, { checksum: "new" })],
        }),
        state: harness.state,
      })
    ).rejects.toThrow("checksum changed")
  })
})

describe("migrateStorage", () => {
  test("runs storage migrators when supported", async () => {
    const calls: string[] = []
    const migrator: StorageMigrator = {
      adapterId: "SixbFakeStorage",
      latestVersion: 1,
      async plan() {
        throw new Error("plan should not be called")
      },
      async migrate() {
        calls.push("storage")
        return {
          adapterId: "SixbFakeStorage",
          latestVersion: 1,
          status: "migrated",
          applied: ["001-create-objects"],
          skipped: [],
        }
      },
    }
    const storage = Object.assign(new InMemoryStorage(), { migrators: [migrator] })

    const result = await migrateStorage(storage)

    expect(calls).toEqual(["storage"])
    expect(result).toEqual({
      status: "migrated",
      reports: [
        {
          adapterId: "SixbFakeStorage",
          latestVersion: 1,
          status: "migrated",
          applied: ["001-create-objects"],
          skipped: [],
        },
      ],
    })
  })

  test("skips storage migrations when unsupported", async () => {
    const result = await migrateStorage(new InMemoryStorage())

    expect(result).toEqual({ status: "skipped", reports: [] })
  })
})
