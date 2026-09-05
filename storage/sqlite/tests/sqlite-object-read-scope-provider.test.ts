import { Database, type SQLQueryBindings } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateStorage } from "@sixb/core"
import {
  compileSelectedObjectReadScope,
  linkBatchKey,
  type ObjectReadExecutionLimits,
  type ObjectReadScopeFactory,
  type ObjectReadStorage,
  type ObjectStorage,
  objectBatchKey,
  type SelectedObjectReadScope,
} from "@sixb/core/storage"
import { SqliteStorage } from "../src"
import { installFreshSqliteSchema, sqliteStoragePath } from "../src/migrations"
import { compileSqliteSelectedObjectReadSource } from "../src/object-read-scope"
import { SqliteObjectStorage } from "../src/object-storage"
import { runImmediateTransactionAsync } from "../src/transactions"

const projectId = "sqlite-selected-reader"
const RootType = "SqliteScopeRoot"
const TargetType = "SqliteScopeTarget"
const timestamp = "2026-08-31T00:00:00.000Z"
const generousLimits: ObjectReadExecutionLimits = {
  maxTraversalFacts: 100,
  maxOutputJsonBytes: 1_000_000,
}

describe("SqliteObjectStorage selected reader invariants", () => {
  test("counts live path facts exactly and preserves redacted JSON values", async () => {
    const storage = new SqliteObjectStorage()
    try {
      const db = databaseOf(storage)
      insertObject(db, RootType, "root-1", {
        id: "root-1",
        nested: { key: "value" },
        values: [1, true, null],
        enabled: true,
        disabled: false,
        nullable: null,
        amount: 2.5,
        hidden: "root-secret",
      })
      insertObject(db, TargetType, "target-1", {
        id: "target-1",
        label: "visible",
        hidden: "target-secret",
      })
      insertLink(db, "root-1", "items", "target-1", {
        nested: { edge: true },
        values: [false, null, 3],
        enabled: true,
        disabled: false,
        nullable: null,
        amount: 7.5,
        hidden: "edge-secret",
      })
      // A stored edge whose target is absent is not a live traversal fact.
      insertLink(db, "root-1", "items", "target-missing", { enabled: true })
      const otherProjectId = `${projectId}-other`
      insertObject(db, RootType, "root-1", { id: "other-root" }, otherProjectId)
      insertObject(db, TargetType, "target-1", { id: "other-target" }, otherProjectId)
      insertLink(db, "root-1", "items", "target-1", { enabled: false }, otherProjectId)

      const scope = repeatedPathScope()
      const exact = createReader(storage, scope, { ...generousLimits, maxTraversalFacts: 3 })
      expect((await exact.list({ projectId })).objects.map((row) => row.primaryId).sort()).toEqual([
        "root-1",
        "target-1",
      ])
      expect(
        (await exact.list({ projectId })).objects.every((row) => row.projectId === projectId)
      ).toBe(true)
      expect(
        await exact.getByPrimaryId({
          projectId,
          objectTypeId: RootType,
          primaryId: "root-1",
        })
      ).toMatchObject({
        properties: {
          id: "root-1",
          nested: { key: "value" },
          values: [1, true, null],
          enabled: true,
          disabled: false,
          nullable: null,
          amount: 2.5,
        },
      })
      const links = await exact.listLinks({
        projectId,
        objectTypeId: RootType,
        objectId: "root-1",
        linkId: "items",
      })
      expect(links).toHaveLength(1)
      expect(links[0]?.properties).toEqual({
        nested: { edge: true },
        values: [false, null, 3],
        enabled: true,
        disabled: false,
        nullable: null,
        amount: 7.5,
      })

      const batch = await exact.getByPrimaryIdBatch({
        projectId,
        items: [
          { objectTypeId: TargetType, primaryId: "target-1" },
          { objectTypeId: RootType, primaryId: "root-1" },
          { objectTypeId: TargetType, primaryId: "target-1" },
        ],
      })
      expect([...batch.keys()]).toEqual([
        objectBatchKey(TargetType, "target-1"),
        objectBatchKey(RootType, "root-1"),
      ])
      const linkBatch = await exact.listLinksBatch({
        projectId,
        items: [
          { objectTypeId: TargetType, objectId: "target-1", linkId: "items" },
          { objectTypeId: RootType, objectId: "root-1", linkId: "items" },
        ],
        direction: "both",
      })
      expect([...linkBatch.keys()]).toEqual([
        linkBatchKey(TargetType, "target-1", "items"),
        linkBatchKey(RootType, "root-1", "items"),
      ])

      const overBudget = createReader(storage, scope, {
        ...generousLimits,
        maxTraversalFacts: 2,
      })
      await expect(overBudget.list({ projectId })).rejects.toMatchObject({
        code: "object_read_limit_exceeded",
        metric: "traversalFacts",
        limit: 2,
      })
      await expect(
        overBudget.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: RootType, primaryId: "root-1" }],
          direction: "outgoing",
          limit: 0,
        })
      ).rejects.toThrow("positive safe integer")
    } finally {
      storage.close()
    }
  })

  test("wraps main, total, and has-more statements in the selected source", async () => {
    const storage = new SqliteObjectStorage()
    try {
      const db = databaseOf(storage)
      insertObject(db, RootType, "root-1", { id: "root-1" })
      insertObject(db, TargetType, "target-a", { id: "target-a", enabled: true, hidden: "a" })
      insertObject(db, TargetType, "target-b", { id: "target-b", enabled: false, hidden: "b" })
      insertObject(db, TargetType, "target-hidden", { id: "target-hidden" })
      insertLink(db, "root-1", "items", "target-a")
      insertLink(db, "root-1", "items", "target-b")
      const reader = createReader(storage, singlePathScope())

      const withTotal = await reader.queryObjects?.({
        projectId,
        query: { kind: "start", objectTypeId: TargetType },
      })
      expect(withTotal).toMatchObject({
        total: 2,
        hasMore: false,
        objects: [{ primaryId: "target-a" }, { primaryId: "target-b" }],
      })
      expect(withTotal?.objects[0]?.properties).toEqual({ id: "target-a", enabled: true })

      const withoutTotal = await reader.queryObjects?.({
        projectId,
        includeTotal: false,
        query: {
          kind: "sort",
          fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
          input: {
            kind: "limit",
            limit: 1,
            input: { kind: "start", objectTypeId: TargetType },
          },
        },
      })
      expect(withoutTotal).toMatchObject({
        hasMore: true,
        objects: [{ primaryId: "target-a" }],
      })
      expect(withoutTotal).not.toHaveProperty("total")

      const projected = await reader.queryObjects?.({
        projectId,
        query: {
          kind: "project",
          properties: ["id", "enabled"],
          input: { kind: "start", objectTypeId: TargetType },
        },
      })
      expect(projected?.objects.map((object) => object.properties)).toEqual([
        { id: "target-a", enabled: true },
        { id: "target-b", enabled: false },
      ])

      const propertylessLinks = await reader.listLinks({
        projectId,
        objectTypeId: RootType,
        objectId: "root-1",
        linkId: "items",
      })
      expect(propertylessLinks).toHaveLength(2)
      expect(propertylessLinks.every((link) => !Object.hasOwn(link, "properties"))).toBe(true)
    } finally {
      storage.close()
    }
  })

  test("serializes a large compiled scope into one bounded statement parameter", () => {
    const scope = compileSelectedObjectReadScope({
      kind: "selected",
      roots: Array.from({ length: 400 }, (_, index) => ({
        anchor: { objectTypeId: RootType, primaryId: `root-${index}` },
        node: {
          objects: [{ objectTypeId: RootType, propertyIds: ["id"] }],
          links: [],
        },
      })),
    })
    const source = compileSqliteSelectedObjectReadSource(projectId, scope, 1_000)
    const statement = source.wrapStatement("SELECT ? AS terminal", ["value"])

    expect(statement.args).toHaveLength(3)
    expect(statement.args[0]).toBeString()
    expect(statement.args[1]).toBe(projectId)
    expect(statement.args[2]).toBe("value")
    expect(statement.sql.match(/json\(\?\)/g)).toHaveLength(1)
  })

  test("reuses provider-owned transactions and rejects unverified ones", async () => {
    const storage = new SqliteObjectStorage()
    try {
      const db = databaseOf(storage)
      insertObject(db, RootType, "root-1", { id: "root-1" })
      const reader = createReader(storage, rootOnlyScope())

      const row = await runImmediateTransactionAsync(db, () =>
        reader.getByPrimaryId({
          projectId,
          objectTypeId: RootType,
          primaryId: "root-1",
        })
      )
      expect(row?.primaryId).toBe("root-1")

      db.run("BEGIN DEFERRED")
      try {
        await expect(reader.list({ projectId })).rejects.toThrow("unverified SQLite transaction")
      } finally {
        db.run("ROLLBACK")
      }
    } finally {
      storage.close()
    }
  })

  test("runs selected reads through the file-backed readonly production connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-selected-readonly-"))
    const storage = new SqliteStorage({ path: directory })
    let writer: Database | undefined
    try {
      await migrateStorage(storage)
      writer = new Database(sqliteStoragePath(directory))
      insertObject(writer, RootType, "root-1", { id: "root-1", hidden: "secret" })

      const factory = storage.objects as ObjectStorage & ObjectReadScopeFactory
      const reader = factory.createSelectedReadScope({
        projectId,
        scope: compileSelectedObjectReadScope(rootOnlyScope()),
        limits: generousLimits,
      })
      expect(
        await reader.getByPrimaryId({
          projectId,
          objectTypeId: RootType,
          primaryId: "root-1",
        })
      ).toMatchObject({ properties: { id: "root-1" } })
    } finally {
      writer?.close()
      storage.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("keeps the traversal probe and every terminal statement on one WAL snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sixb-sqlite-selected-snapshot-"))
    const databasePath = join(directory, "scope.sqlite")
    const setup = new Database(databasePath)
    installFreshSqliteSchema(setup)
    setup.run("PRAGMA journal_mode = WAL")
    setup.close()

    const storage = new SqliteObjectStorage({ path: databasePath })
    const writer = new Database(databasePath)
    writer.run("PRAGMA journal_mode = WAL")
    writer.run("PRAGMA busy_timeout = 5000")
    const holder = storage as unknown as { db: Database }
    const originalDb = holder.db

    try {
      insertObject(originalDb, RootType, "root-1", { id: "root-1" })
      insertObject(originalDb, TargetType, "target-1", { id: "target-1" })
      const reader = createReader(storage, singlePathScope(), {
        ...generousLimits,
        maxTraversalFacts: 1,
      })
      let writerCommitted = false

      holder.db = {
        get inTransaction() {
          return originalDb.inTransaction
        },
        run: originalDb.run.bind(originalDb),
        query: (sql: string) => {
          const statement = originalDb.query(sql)
          return {
            all: (...args: SQLQueryBindings[]) => statement.all(...args),
            get: (...args: SQLQueryBindings[]) => {
              const result = statement.get(...args)
              if (!writerCommitted && sql.includes("bounded_traversal_facts")) {
                writerCommitted = true
                insertLink(writer, "root-1", "items", "target-1")
              }
              return result
            },
          }
        },
      } as unknown as Database

      expect(await reader.list({ projectId })).toEqual({
        objects: [expect.objectContaining({ primaryId: "root-1" })],
        hasMore: false,
        total: 1,
      })
      expect(writerCommitted).toBe(true)

      holder.db = originalDb
      await expect(reader.list({ projectId })).rejects.toMatchObject({
        code: "object_read_limit_exceeded",
        metric: "traversalFacts",
        limit: 1,
      })
    } finally {
      holder.db = originalDb
      writer.close()
      storage.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function createReader(
  storage: SqliteObjectStorage,
  scope: SelectedObjectReadScope,
  limits: ObjectReadExecutionLimits = generousLimits
): ObjectReadStorage {
  return storage.createSelectedReadScope({
    projectId,
    scope: compileSelectedObjectReadScope(scope),
    limits,
  })
}

function rootOnlyScope(): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: [rootSelection("root-1")],
  }
}

function singlePathScope(): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        ...rootSelection("root-1"),
        node: {
          objects: [{ objectTypeId: RootType, propertyIds: ["id"] }],
          links: [targetPath()],
        },
      },
    ],
  }
}

function repeatedPathScope(): SelectedObjectReadScope {
  return {
    kind: "selected",
    roots: [
      {
        ...rootSelection("root-1"),
        node: {
          objects: [
            {
              objectTypeId: RootType,
              propertyIds: ["id", "nested", "values", "enabled", "disabled", "nullable", "amount"],
            },
          ],
          links: [targetPath(true), targetPath(true)],
        },
      },
      rootSelection("root-missing"),
    ],
  }
}

function rootSelection(primaryId: string) {
  return {
    anchor: { objectTypeId: RootType, primaryId },
    node: {
      objects: [{ objectTypeId: RootType, propertyIds: ["id"] }],
      links: [],
    },
  }
}

function targetPath(selectLinkValues = false) {
  return {
    definitions: [
      {
        sourceObjectTypeId: RootType,
        linkId: "items",
        targetObjectTypeIds: [TargetType],
        propertyIds: selectLinkValues
          ? ["nested", "values", "enabled", "disabled", "nullable", "amount"]
          : [],
      },
    ],
    target: {
      objects: [{ objectTypeId: TargetType, propertyIds: ["id", "label", "enabled"] }],
      links: [],
    },
  }
}

function databaseOf(storage: SqliteObjectStorage): Database {
  return (storage as unknown as { db: Database }).db
}

function insertObject(
  db: Database,
  objectTypeId: string,
  primaryId: string,
  properties: Readonly<Record<string, unknown>>,
  rowProjectId = projectId
): void {
  db.query(`
    INSERT INTO objects (
      project_id, object_type_id, primary_id, properties,
      created_at, updated_at, version, last_commit_id
    ) VALUES (?, ?, ?, json(?), ?, ?, 1, ?)
  `).run(
    rowProjectId,
    objectTypeId,
    primaryId,
    JSON.stringify(properties),
    timestamp,
    timestamp,
    "scope-test"
  )
}

function insertLink(
  db: Database,
  sourceId: string,
  linkId: string,
  targetId: string,
  properties?: Readonly<Record<string, unknown>>,
  rowProjectId = projectId
): void {
  db.query(`
    INSERT INTO links (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id,
      properties, created_at, updated_at, last_commit_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rowProjectId,
    RootType,
    sourceId,
    linkId,
    TargetType,
    targetId,
    properties === undefined ? null : JSON.stringify(properties),
    timestamp,
    timestamp,
    "scope-test"
  )
}
