import { describe, expect, test } from "bun:test"
import {
  compileSelectedObjectReadScope,
  type ObjectReadExecutionLimits,
  type SelectedObjectReadScope,
} from "@sixb/core/storage"
import type { SQLClient, SqlParameter } from "../src/pg-client"
import {
  compilePgObjectCountQuery,
  compilePgObjectExistsQuery,
  compilePgObjectFacetQuery,
  compilePgObjectQuery,
  compilePgObjectStatement,
} from "../src/pg-object-query-compiler"
import { compilePgSelectedObjectReadSource } from "../src/pg-object-read-scope"
import { PgObjectStorage } from "../src/pg-object-storage"
import type { PgStoreClient } from "../src/transactions"

const projectId = "pg-selected-reader"
const RootType = "PgScopeRoot"
const limits: ObjectReadExecutionLimits = {
  maxTraversalFacts: 100,
  maxOutputJsonBytes: 1_000_000,
}

describe("PgObjectStorage selected reader compilation", () => {
  test("serializes a large compiled scope into one bounded statement parameter", () => {
    const scope = compileSelectedObjectReadScope({
      kind: "selected",
      roots: Array.from({ length: 400 }, (_, index) => rootSelection(`root-${index}`)),
    })
    const source = compilePgSelectedObjectReadSource(projectId, scope, Number.MAX_SAFE_INTEGER)
    const statement = compilePgObjectStatement("SELECT ?::text AS terminal", ["value"], source)

    expect(statement.args).toHaveLength(3)
    expect(statement.args[0]).toBeString()
    expect(statement.args[1]).toBe(projectId)
    expect(statement.args[2]).toBe("value")
    expect(statement.sql.match(/\$1::text::jsonb/g)).toHaveLength(1)
    expect(highestPlaceholder(statement.sql)).toBe(statement.args.length)
    expect(source.traversalProbe.args.at(-1)).toBe(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
  })

  test("wraps main, total, and has-more query statements in the selected source", () => {
    const source = compilePgSelectedObjectReadSource(
      projectId,
      compileSelectedObjectReadScope(rootOnlyScope()),
      limits.maxTraversalFacts
    )
    const compiled = compilePgObjectQuery(
      projectId,
      {
        kind: "sort",
        fields: [{ kind: "property", propertyId: "id", direction: "asc" }],
        input: {
          kind: "limit",
          limit: 1,
          input: { kind: "start", objectTypeId: RootType },
        },
      },
      { includeTotal: false, source }
    )

    for (const statement of [
      { sql: compiled.sql, args: compiled.args },
      { sql: compiled.totalSql, args: compiled.totalArgs },
      compiled.hasMoreProbe,
    ]) {
      if (!statement) throw new Error("expected a has-more probe")
      expect(statement.sql).toContain("WITH RECURSIVE")
      expect(statement.sql).toContain("_sixb_scope_objects")
      expect(statement.args[0]).toBeString()
      expect(statement.args[1]).toBe(projectId)
      expect(highestPlaceholder(statement.sql)).toBe(statement.args.length)
    }
  })

  test("wraps aggregate query statements in the selected source", () => {
    const source = compilePgSelectedObjectReadSource(
      projectId,
      compileSelectedObjectReadScope(rootOnlyScope()),
      limits.maxTraversalFacts
    )
    const query = { kind: "start", objectTypeId: RootType } as const

    for (const statement of [
      compilePgObjectCountQuery(projectId, query, { source }),
      compilePgObjectExistsQuery(projectId, query, { source }),
      compilePgObjectFacetQuery(projectId, query, "id", 10, { source }),
    ]) {
      expect(statement.sql).toContain("WITH RECURSIVE")
      expect(statement.sql).toContain("_sixb_scope_objects")
      expect(statement.args[0]).toBeString()
      expect(statement.args[1]).toBe(projectId)
      expect(highestPlaceholder(statement.sql)).toBe(statement.args.length)
    }
  })

  test("compiles endpoint-filtered link reads with exact args and canonical collation", async () => {
    const { sql, calls, beginCalls } = recordingPool()
    const storage = new PgObjectStorage(sql)
    const reader = storage.createSelectedReadScope({
      projectId,
      scope: compileSelectedObjectReadScope(rootOnlyScope()),
      limits,
    })
    const allowedTypes = [RootType, "PgScopeTarget"]

    expect(
      await reader.queryLinks({
        projectId,
        objectRefs: [
          { objectTypeId: RootType, primaryId: "root-1" },
          { objectTypeId: RootType, primaryId: "root-1" },
        ],
        direction: "both",
        linkId: "items",
        endpointObjectTypeIds: allowedTypes,
        after: [RootType, "root-0", "items", "PgScopeTarget", "target-é"],
        limit: 20,
      })
    ).toEqual({ links: [], hasMore: false })

    expect(beginCalls).toEqual(["isolation level repeatable read"])
    expect(calls).toHaveLength(2)
    const terminal = calls[1]
    if (!terminal) throw new Error("expected a terminal query")
    expect(terminal.sql).toContain("CROSS JOIN LATERAL")
    expect(terminal.sql).toContain("SELECT DISTINCT link.*")
    expect(terminal.sql).toContain('COLLATE "C"')
    expect(terminal.sql).toContain("_sixb_scope_links")
    expect(highestPlaceholder(terminal.sql)).toBe(terminal.args.length)
    expect(terminal.args.filter((value) => value === JSON.stringify(allowedTypes))).toHaveLength(2)
    expect(terminal.args.at(-1)).toBe(21)
  })

  test("rejects an invalid link-query limit before opening a transaction or probing", async () => {
    const { sql, calls, beginCalls } = recordingPool()
    const reader = new PgObjectStorage(sql).createSelectedReadScope({
      projectId,
      scope: compileSelectedObjectReadScope(rootOnlyScope()),
      limits,
    })

    await expect(
      reader.queryLinks({
        projectId,
        objectRefs: [{ objectTypeId: RootType, primaryId: "root-1" }],
        direction: "outgoing",
        limit: 0,
      })
    ).rejects.toThrow("positive safe integer")
    expect(beginCalls).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test("wraps every interactive terminal in the selected source", async () => {
    const { sql, calls } = recordingPool()
    const reader = new PgObjectStorage(sql).createSelectedReadScope({
      projectId,
      scope: compileSelectedObjectReadScope(rootOnlyScope()),
      limits,
    })
    const operations: readonly (() => Promise<unknown>)[] = [
      () =>
        reader.queryObjects?.({
          projectId,
          query: { kind: "start", objectTypeId: RootType },
        }) ?? Promise.reject(new Error("queryObjects missing")),
      () =>
        reader.countObjects?.({
          projectId,
          query: { kind: "start", objectTypeId: RootType },
        }) ?? Promise.reject(new Error("countObjects missing")),
      () =>
        reader.existsObjects?.({
          projectId,
          query: { kind: "start", objectTypeId: RootType },
        }) ?? Promise.reject(new Error("existsObjects missing")),
      () =>
        reader.facetObjects?.({
          projectId,
          query: { kind: "start", objectTypeId: RootType },
          facets: [{ propertyId: "id", limit: 10 }],
        }) ?? Promise.reject(new Error("facetObjects missing")),
      () => reader.getByPrimaryId({ projectId, objectTypeId: RootType, primaryId: "root-1" }),
      () =>
        reader.selectsObjectProperties({
          projectId,
          items: [{ objectTypeId: RootType, primaryId: "root-1", propertyId: "id" }],
        }),
      () =>
        reader.listLinks({
          projectId,
          objectTypeId: RootType,
          objectId: "root-1",
          direction: "both",
        }),
      () =>
        reader.getByPrimaryIdBatch({
          projectId,
          items: [{ objectTypeId: RootType, primaryId: "root-1" }],
        }),
      () =>
        reader.listLinksBatch({
          projectId,
          direction: "both",
          items: [{ objectTypeId: RootType, objectId: "root-1", linkId: "items" }],
        }),
      () =>
        reader.queryLinks({
          projectId,
          objectRefs: [{ objectTypeId: RootType, primaryId: "root-1" }],
          direction: "both",
          limit: 10,
        }),
      () => reader.list({ projectId }),
    ]

    for (const operation of operations) {
      const start = calls.length
      await operation()
      const operationCalls = calls.slice(start)
      expect(operationCalls.length).toBeGreaterThanOrEqual(2)
      for (const call of operationCalls) {
        expect(call.sql).toContain("WITH RECURSIVE")
        expect(call.sql).toContain("_sixb_scope_document")
        expect(call.args[0]).toBeString()
        expect(call.args[1]).toBe(projectId)
        expect(highestPlaceholder(call.sql)).toBe(call.args.length)
      }
    }
  })
})

function recordingPool(): {
  readonly sql: PgStoreClient
  readonly calls: { readonly sql: string; readonly args: readonly SqlParameter[] }[]
  readonly beginCalls: string[]
} {
  const calls: { sql: string; args: readonly SqlParameter[] }[] = []
  const beginCalls: string[] = []
  const tx = {
    unsafe: async <T extends readonly unknown[]>(sql: string, args: SqlParameter[]): Promise<T> => {
      calls.push({ sql, args })
      if (sql.includes("bounded_traversal_facts")) {
        return [{ total: "0" }] as unknown as T
      }
      return [] as unknown as T
    },
  } as unknown as SQLClient
  const sql = {
    begin: async (mode: string, run: (client: SQLClient) => Promise<unknown>) => {
      beginCalls.push(mode)
      return run(tx)
    },
  } as unknown as PgStoreClient
  return { sql, calls, beginCalls }
}

function highestPlaceholder(sql: string): number {
  return Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))
}

function rootOnlyScope(): SelectedObjectReadScope {
  return { kind: "selected", roots: [rootSelection("root-1")] }
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
