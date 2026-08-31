import { describe, expect, test } from "bun:test"
import {
  compileSelectedObjectReadScope,
  linkBatchKey,
  type ObjectReadExecutionLimits,
  type ObjectReadStorage,
  objectBatchKey,
  type SelectedObjectReadScope,
} from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import type { SQL, SQLClient, SqlParameter } from "../src/pg-client"
import { PgObjectStorage } from "../src/pg-object-storage"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage } from "./helpers"

const projectId = "pg-selected-reader"
const otherProjectId = `${projectId}-other`
const RootType = "PgScopeRoot"
const TargetType = "PgScopeTarget"
const timestamp = "2026-08-31T00:00:00.000Z"
const generousLimits: ObjectReadExecutionLimits = {
  maxTraversalFacts: 100_000,
  maxOutputJsonBytes: 10_000_000,
}

describe("PgObjectStorage selected reader invariants", () => {
  test("counts exact path facts and preserves redacted JSONB within one project", async () => {
    const { storage } = await createTestStorage()
    try {
      const sql = sqlOf(storage)
      await insertObject(sql, RootType, "root-1", {
        id: "root-1",
        nested: { key: "value" },
        values: [1, true, null],
        enabled: true,
        disabled: false,
        nullable: null,
        amount: 2.5,
        "clé:🧪": { 值: true },
        hidden: "root-secret",
      })
      await insertObject(sql, TargetType, "target-1", {
        id: "target-1",
        label: "visible",
        hidden: "target-secret",
      })
      await insertLink(sql, "root-1", "items", "target-1", {
        nested: { edge: true },
        values: [false, null, 3],
        enabled: true,
        disabled: false,
        nullable: null,
        amount: 7.5,
        hidden: "edge-secret",
      })
      await insertLink(sql, "root-1", "items", "target-missing", { enabled: true })
      await insertObject(sql, RootType, "root-1", { id: "other-root" }, otherProjectId)
      await insertObject(sql, TargetType, "target-1", { id: "other-target" }, otherProjectId)
      await insertObject(
        sql,
        TargetType,
        "target-missing",
        { id: "other-project-only-target" },
        otherProjectId
      )
      await insertLink(sql, "root-1", "items", "target-1", { enabled: false }, otherProjectId)

      const exact = createReader(storage, repeatedPathScope(), {
        ...generousLimits,
        maxTraversalFacts: 3,
      })
      const listed = await exact.list({ projectId, orderBy: "primaryId", order: "asc" })
      expect(listed.objects.map((row) => row.primaryId)).toEqual(["root-1", "target-1"])
      expect(listed.objects.every((row) => row.projectId === projectId)).toBe(true)
      expect(
        await exact.getByPrimaryId({ projectId, objectTypeId: RootType, primaryId: "root-1" })
      ).toMatchObject({
        properties: {
          id: "root-1",
          nested: { key: "value" },
          values: [1, true, null],
          enabled: true,
          disabled: false,
          nullable: null,
          amount: 2.5,
          "clé:🧪": { 值: true },
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
        direction: "both",
        items: [
          { objectTypeId: TargetType, objectId: "target-1", linkId: "items" },
          { objectTypeId: RootType, objectId: "root-1", linkId: "items" },
        ],
      })
      expect([...linkBatch.keys()]).toEqual([
        linkBatchKey(TargetType, "target-1", "items"),
        linkBatchKey(RootType, "root-1", "items"),
      ])

      const overBudget = createReader(storage, repeatedPathScope(), {
        ...generousLimits,
        maxTraversalFacts: 2,
      })
      await expect(overBudget.list({ projectId })).rejects.toMatchObject({
        code: "object_read_limit_exceeded",
        metric: "traversalFacts",
        limit: 2,
      })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })

  test("keeps 22k-item batches bounded and link cursors deterministic", async () => {
    const { storage } = await createTestStorage()
    try {
      const sql = sqlOf(storage)
      await insertObject(sql, RootType, "root-1", { id: "root-1" })
      for (const targetId of ["target-a", "target-é", `target-${String.fromCodePoint(0xe000)}`]) {
        await insertObject(sql, TargetType, targetId, { id: targetId, hidden: "secret" })
        await insertLink(sql, "root-1", "items", targetId)
      }
      const reader = createReader(storage, singlePathScope())
      const targetIds = ["target-a", "target-é", `target-${String.fromCodePoint(0xe000)}`]
      const objectItems = Array.from({ length: 22_000 }, (_, index) => {
        if (index < targetIds.length) {
          return { objectTypeId: TargetType, primaryId: targetIds[index] as string }
        }
        if (index === targetIds.length) {
          return { objectTypeId: RootType, primaryId: "root-1" }
        }
        return { objectTypeId: TargetType, primaryId: `missing-${index}` }
      })
      const objects = await reader.getByPrimaryIdBatch({ projectId, items: objectItems })
      expect([...objects.keys()]).toEqual([
        ...targetIds.map((targetId) => objectBatchKey(TargetType, targetId)),
        objectBatchKey(RootType, "root-1"),
      ])

      const linkItems = objectItems.map((item) => ({
        objectTypeId: item.objectTypeId,
        objectId: item.primaryId,
        linkId: "items",
      }))
      const links = await reader.listLinksBatch({
        projectId,
        direction: "both",
        items: linkItems,
      })
      expect([...links.keys()]).toEqual([
        ...targetIds.map((targetId) => linkBatchKey(TargetType, targetId, "items")),
        linkBatchKey(RootType, "root-1", "items"),
      ])
      expect([...links.values()].flat().every((link) => !Object.hasOwn(link, "properties"))).toBe(
        true
      )

      const firstPage = await reader.queryLinks({
        projectId,
        objectRefs: [
          { objectTypeId: RootType, primaryId: "root-1" },
          { objectTypeId: RootType, primaryId: "root-1" },
          { objectTypeId: TargetType, primaryId: "target-a" },
        ],
        direction: "both",
        endpointObjectTypeIds: [RootType, TargetType],
        limit: 2,
      })
      expect(firstPage.links.map((link) => link.targetId)).toEqual(targetIds.slice(0, 2))
      expect(firstPage.hasMore).toBe(true)

      const secondPage = await reader.queryLinks({
        projectId,
        objectRefs: [{ objectTypeId: RootType, primaryId: "root-1" }],
        direction: "outgoing",
        endpointObjectTypeIds: [RootType, TargetType],
        after: [RootType, "root-1", "items", TargetType, targetIds[1] as string],
        limit: 2,
      })
      expect(secondPage).toMatchObject({
        hasMore: false,
        links: [{ targetId: targetIds[2] }],
      })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  }, 30_000)

  test("keeps traversal probe and terminal reads on one repeatable-read snapshot", async () => {
    const { storage } = await createTestStorage()
    try {
      const sql = sqlOf(storage)
      await insertObject(sql, RootType, "root-1", { id: "root-1" })
      await insertObject(sql, TargetType, "target-1", { id: "target-1" })
      let writerCommitted = false
      const beginModes: string[] = []
      const intercepted = {
        begin: (mode: string, run: (client: SQLClient) => Promise<unknown>): Promise<unknown> =>
          sql.begin(mode, async (tx) => {
            beginModes.push(mode)
            const client = {
              unsafe: async (query: string, args: SqlParameter[]) => {
                const result = await tx.unsafe(query, args)
                if (!writerCommitted && query.includes("bounded_traversal_facts")) {
                  writerCommitted = true
                  await insertLink(sql, "root-1", "items", "target-1")
                }
                return result
              },
            } as unknown as SQLClient
            return run(client)
          }) as Promise<unknown>,
      } as unknown as PgStoreClient
      const reader = createReader(new PgObjectStorage(intercepted), singlePathScope(), {
        ...generousLimits,
        maxTraversalFacts: 1,
      })

      expect(await reader.list({ projectId, orderBy: "primaryId", order: "asc" })).toEqual({
        objects: [expect.objectContaining({ primaryId: "root-1" })],
        hasMore: false,
        total: 1,
      })
      expect(beginModes).toEqual(["isolation level repeatable read"])
      expect(writerCommitted).toBe(true)

      const freshReader = createReader(storage, singlePathScope(), {
        ...generousLimits,
        maxTraversalFacts: 1,
      })
      await expect(freshReader.list({ projectId })).rejects.toMatchObject({
        code: "object_read_limit_exceeded",
        metric: "traversalFacts",
        limit: 1,
      })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })

  test("rejects a transaction client whose isolation was not opened by the provider", async () => {
    const { storage } = await createTestStorage()
    try {
      const sql = sqlOf(storage)
      await insertObject(sql, RootType, "root-1", { id: "root-1" })
      await sql.begin(async (tx) => {
        const reader = createReader(new PgObjectStorage(tx), rootOnlyScope())
        await expect(reader.list({ projectId })).rejects.toThrow(
          "cannot join an unverified PostgreSQL transaction"
        )
      })
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })

  test("reuses a serializable PostgresStorage transaction end to end", async () => {
    const { storage } = await createTestStorage()
    let escapedReader: ObjectReadStorage | undefined
    let escapedList: ObjectReadStorage["list"] | undefined
    try {
      await insertObject(sqlOf(storage), RootType, "root-1", { id: "root-1", hidden: "secret" })

      const row = await storage.transaction(
        async (tx) => {
          const reader = tx.objects.createSelectedReadScope({
            projectId,
            scope: compileSelectedObjectReadScope(rootOnlyScope()),
            limits: generousLimits,
          })
          escapedReader = reader
          escapedList = reader.list
          return reader.getByPrimaryId({
            projectId,
            objectTypeId: RootType,
            primaryId: "root-1",
          })
        },
        { isolation: "serializable" }
      )
      expect(row).toMatchObject({ primaryId: "root-1", properties: { id: "root-1" } })
      if (!escapedReader || !escapedList) throw new Error("expected escaped selected reader")
      const reader = escapedReader
      const list = escapedList
      expect(() => reader.queryCapabilities()).toThrow("after transaction completion")
      await expect(Promise.resolve().then(() => list({ projectId }))).rejects.toMatchObject({
        code: "transaction_inactive",
      })

      await expect(
        storage.transaction(async (tx) => {
          const reader = tx.objects.createSelectedReadScope({
            projectId,
            scope: compileSelectedObjectReadScope(rootOnlyScope()),
            limits: generousLimits,
          })
          return reader.list({ projectId })
        })
      ).rejects.toThrow('{ isolation: "serializable" }')
    } finally {
      await storage.dropSchema()
      await storage.close()
    }
  })
})

function createReader(
  storage: PostgresStorage | PgObjectStorage,
  scope: SelectedObjectReadScope,
  limits: ObjectReadExecutionLimits = generousLimits
): ObjectReadStorage {
  const factory = storage instanceof PgObjectStorage ? storage : storage.objects
  return factory.createSelectedReadScope({
    projectId,
    scope: compileSelectedObjectReadScope(scope),
    limits,
  })
}

function rootOnlyScope(): SelectedObjectReadScope {
  return { kind: "selected", roots: [rootSelection("root-1")] }
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
              propertyIds: [
                "id",
                "nested",
                "values",
                "enabled",
                "disabled",
                "nullable",
                "amount",
                "clé:🧪",
              ],
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

function sqlOf(storage: PostgresStorage): SQL {
  return (storage as unknown as { sql: SQL }).sql
}

async function insertObject(
  sql: SQLClient,
  objectTypeId: string,
  primaryId: string,
  properties: Readonly<Record<string, unknown>>,
  rowProjectId = projectId
): Promise<void> {
  await sql.unsafe(
    `
      INSERT INTO objects (
        project_id, object_type_id, primary_id, properties,
        created_at, updated_at, version, last_commit_id
      ) VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, 1, $7)
    `,
    [
      rowProjectId,
      objectTypeId,
      primaryId,
      JSON.stringify(properties),
      timestamp,
      timestamp,
      "scope-test",
    ]
  )
}

async function insertLink(
  sql: SQLClient,
  sourceId: string,
  linkId: string,
  targetId: string,
  properties?: Readonly<Record<string, unknown>>,
  rowProjectId = projectId
): Promise<void> {
  await sql.unsafe(
    `
      INSERT INTO links (
        project_id, source_type_id, source_id, link_id, target_type_id, target_id,
        properties, created_at, updated_at, last_commit_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8, $9, $10)
    `,
    [
      rowProjectId,
      RootType,
      sourceId,
      linkId,
      TargetType,
      targetId,
      properties === undefined ? null : JSON.stringify(properties),
      timestamp,
      timestamp,
      "scope-test",
    ]
  )
}
