import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import { SqliteStorage } from "../src"
import {
  SQLITE_STORAGE_ADAPTER_ID,
  sqliteStorageMigrations,
  sqliteStoragePath,
} from "../src/migrations"

const tempDirs: string[] = []
const expectedStorageMigrationRows = [
  {
    adapter_id: SQLITE_STORAGE_ADAPTER_ID,
    checksum_length: 64,
    id: "001-initial-schema",
    status: "applied",
    version: 1,
  },
]

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()

    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe("SQLite storage migrations", () => {
  test("migrateStorage writes storage-level migration history", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    const result = await migrateStorage(storage)

    closeStorage(storage)

    expect(result.status).toBe("migrated")
    expect(readMigrationRows(sqliteStoragePath(tempDir))).toEqual(expectedStorageMigrationRows)
  })

  test("repeated migration planning is idempotent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-idempotent-migrations-"))
    tempDirs.push(tempDir)
    const storage = new SqliteStorage({ path: tempDir })
    try {
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "migrated" })
      await expect(migrateStorage(storage)).resolves.toMatchObject({ status: "current" })
    } finally {
      storage.close()
    }
  })

  test("recorded old checksums are rejected before schema mutation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-checksum-"))
    tempDirs.push(tempDir)
    const path = sqliteStoragePath(tempDir)

    const first = new SqliteStorage({ path: tempDir })
    await migrateStorage(first)
    closeStorage(first)

    const db = new Database(path)
    db.query(
      "UPDATE sixb_migrations SET checksum = 'old-checksum' WHERE adapter_id = ? AND version = 1"
    ).run(SQLITE_STORAGE_ADAPTER_ID)
    db.close()

    const reopened = new SqliteStorage({ path: tempDir })
    await expect(migrateStorage(reopened)).rejects.toThrow("checksum")
    closeStorage(reopened)

    expect(readTableNames(path)).toContain("ontology_outbox")
    expect(readMigrationRows(path)[0]?.checksum_length).toBe("old-checksum".length)
  })

  test("fresh schema installs the exact ontology table set and provenance columns", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)
      const ontologyTables = readMemoryTableNames(db).filter((name) => name.startsWith("ontology_"))
      expect(ontologyTables).toEqual([
        "ontology_commits",
        "ontology_outbox",
        "ontology_overrides",
        "ontology_source_rows",
        "ontology_sources",
      ])
      expect(readMemoryTableColumns(db, "objects")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "links")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "timeseries")).toContain("last_commit_id")
      expect(readMemoryTableColumns(db, "objects")).not.toContain("source_event_id")
      expect(readMemoryTableColumns(db, "links")).not.toContain("source_event_id")
      expect(readMemoryTableColumns(db, "timeseries")).not.toContain("source_event_id")
      expect(readMemoryTableNames(db)).not.toContain("applied_events_objects")
      expect(readMemoryColumn(db, "objects", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "links", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryColumn(db, "timeseries", "last_commit_id")?.notnull).toBe(1)
      expect(readMemoryTableColumns(db, "projection_runs")).toEqual(
        expect.arrayContaining([
          "attempt",
          "execution_token",
          "materialization_protocol",
          "dataset_version_created_at",
          "fixed_batch_size",
          "next_batch_ordinal",
          "next_row_offset",
          "input_exhausted",
        ])
      )
    } finally {
      db.close()
    }
  })

  test("migrations install auth storage tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-auth-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    await storage.auth.users.create({
      id: "usr_1",
      projectId: "project-a",
      email: "ava@acme.com",
      createdAt: new Date("2026-05-14T10:00:00.000Z"),
    })
    await expect(
      storage.auth.users.getByEmail({
        projectId: "project-a",
        email: "ava@acme.com",
      })
    ).resolves.toMatchObject({
      id: "usr_1",
      email: "ava@acme.com",
    })

    closeStorage(storage)

    const tables = readTableNames(sqliteStoragePath(tempDir))
    const sessionColumns = readTableColumns(sqliteStoragePath(tempDir), "auth_sessions")
    expect(tables).toContain("auth_users")
    expect(tables).toContain("auth_user_identities")
    expect(tables).toContain("auth_service_accounts")
    expect(tables).toContain("auth_service_account_group_memberships")
    expect(tables).toContain("auth_sessions")
    expect(tables).toContain("auth_access_tokens")
    expect(tables).toContain("auth_invitations")
    expect(tables).toContain("auth_invitation_groups")
    expect(tables).toContain("auth_group_memberships")
    expect(tables).toContain("auth_magic_links")
    expect(tables).toContain("auth_oidc_authorization_attempts")
    expect(sessionColumns).toContain("audience")
    expect(sessionColumns).toContain("absolute_expires_at")
    expect(sessionColumns).toContain("user_agent")
    expect(sessionColumns).toContain("ip_address")
  })

  test("migrations install agent storage tables", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-agent-migrations-"))
    tempDirs.push(tempDir)

    const storage = new SqliteStorage({ path: tempDir })
    await migrateStorage(storage)

    await storage.agents.threads.create({
      id: "thr_1",
      projectId: "project-a",
      agentId: "sales",
      ownerPrincipal: { type: "user", id: "usr_1" },
      createdAt: new Date("2026-06-23T10:00:00.000Z"),
    })
    await expect(
      storage.agents.threads.getById({ projectId: "project-a", id: "thr_1" })
    ).resolves.toMatchObject({ id: "thr_1", agentId: "sales", messageCount: 0 })

    closeStorage(storage)

    const tables = readTableNames(sqliteStoragePath(tempDir))
    expect(tables).toContain("agent_threads")
    expect(tables).toContain("agent_runs")
    expect(tables).toContain("agent_messages")
  })

  test("untracked existing schema collides and rolls back without conversion", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-legacy-"))
    tempDirs.push(tempDir)

    const path = sqliteStoragePath(tempDir)
    const legacy = new Database(path)
    legacy.run("CREATE TABLE objects (legacy_marker TEXT NOT NULL)")
    legacy.run("INSERT INTO objects (legacy_marker) VALUES ('preserve-me')")
    legacy.close()

    const storage = new SqliteStorage({ path: tempDir })
    await expect(migrateStorage(storage)).rejects.toThrow("table objects already exists")
    closeStorage(storage)

    const unchanged = new Database(path, { readonly: true })
    expect(unchanged.query("SELECT legacy_marker FROM objects").get()).toEqual({
      legacy_marker: "preserve-me",
    })
    expect(readTableNames(path)).not.toContain("ontology_commits")
    expect(readMigrationRows(path)).toEqual([])
    unchanged.close()
  })

  test("dirty SQLite migration history blocks storage migrations", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-sqlite-dirty-"))
    tempDirs.push(tempDir)

    writeStartedMigration(sqliteStoragePath(tempDir))

    const storage = new SqliteStorage({ path: tempDir })

    await expect(migrateStorage(storage)).rejects.toThrow("dirty migration state")

    closeStorage(storage)
  })

  test("the timeseries primary key enforces the (series, at) natural key", () => {
    const db = new Database(":memory:")
    try {
      sqliteStorageMigrations.steps[0]?.up(db)

      const insert = db.query(`
        INSERT INTO timeseries (
          project_id, object_type_id, object_id, property_id,
          value, unit, at, last_commit_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      insert.run("p", "Room", "r1", "temp", "70.5", null, "2026-06-01T12:00:00.000Z", "commit-1")

      // A second row at the same (series, at) is rejected by the natural-key
      // PRIMARY KEY, even with a different commit — appends must upsert.
      expect(() =>
        insert.run("p", "Room", "r1", "temp", "71", null, "2026-06-01T12:00:00.000Z", "commit-2")
      ).toThrow()
    } finally {
      db.close()
    }
  })
})

function readMigrationRows(path: string): Array<{
  adapter_id: string
  checksum_length: number
  id: string
  status: string
  version: number
}> {
  const db = new Database(path, { readonly: true })

  try {
    return db
      .query(`
        SELECT adapter_id, version, id, status, length(checksum) AS checksum_length
        FROM sixb_migrations
        ORDER BY adapter_id, version
      `)
      .all() as Array<{
      adapter_id: string
      checksum_length: number
      id: string
      status: string
      version: number
    }>
  } finally {
    db.close()
  }
}

function readTableNames(path: string): readonly string[] {
  const db = new Database(path, { readonly: true })

  try {
    const rows = db
      .query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
        ORDER BY name
      `)
      .all() as Array<{ readonly name: string }>

    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

function readTableColumns(path: string, tableName: string): readonly string[] {
  const db = new Database(path, { readonly: true })

  try {
    const rows = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      readonly name: string
    }>

    return rows.map((row) => row.name)
  } finally {
    db.close()
  }
}

function readMemoryTableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      readonly name: string
    }[]
  ).map((row) => row.name)
}

function readMemoryTableColumns(db: Database, tableName: string): string[] {
  return (db.query(`PRAGMA table_info(${tableName})`).all() as { readonly name: string }[]).map(
    (row) => row.name
  )
}

function readMemoryColumn(
  db: Database,
  tableName: string,
  columnName: string
): { readonly name: string; readonly notnull: number } | undefined {
  const columns = db.query(`PRAGMA table_info(${tableName})`).all() as Array<{
    readonly name: string
    readonly notnull: number
  }>
  return columns.find((column) => column.name === columnName)
}

function writeStartedMigration(path: string): void {
  const db = new Database(path)

  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS sixb_migrations (
        adapter_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        id TEXT NOT NULL,
        checksum TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (adapter_id, version)
      );
    `)

    db.query(`
      INSERT INTO sixb_migrations (
        adapter_id, version, id, checksum, status, started_at, finished_at
      ) VALUES (?, 1, '001-initial-schema', NULL, 'started', ?, NULL)
    `).run(SQLITE_STORAGE_ADAPTER_ID, "2026-04-19T00:00:00.000Z")
  } finally {
    db.close()
  }
}

function closeStorage(storage: SqliteStorage): void {
  storage.close()
}
