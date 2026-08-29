import { describe, expect, test } from "bun:test"
import type { ObjectReadScope } from "@sixb/core/storage"
import { PgObjectStorage } from "../src/pg-object-storage"
import type { PgStoreClient } from "../src/transactions"

const projectId = "transaction-scope-project"
const selectedRoot: ObjectReadScope = {
  kind: "selected",
  roots: [
    {
      anchor: { objectTypeId: "Proposal", primaryId: "p1" },
      node: {
        objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
        links: [],
      },
    },
  ],
}

describe("PgObjectStorage scoped read transactions", () => {
  test("keeps the traversal probe, total, and rows on one repeatable-read client", async () => {
    // Regression guard: remove the scoped runPgTransaction call, or execute the terminal through
    // the root pool, and this test fails before returning a result.
    const responses: unknown[][] = [
      [{ total: 1 }],
      [{ total: 1 }],
      [
        {
          project_id: projectId,
          object_type_id: "Proposal",
          primary_id: "p1",
          properties: { id: "p1" },
          created_at: "2026-08-28T00:00:00.000Z",
          updated_at: "2026-08-28T00:00:00.000Z",
          version: 1,
          last_commit_id: "commit-1",
        },
      ],
    ]
    const transactionSql: string[] = []
    const beginCalls: unknown[][] = []
    let transactionActive = false
    let rootUnsafeCalls = 0
    const tx = {
      unsafe: async (sql: string) => {
        expect(transactionActive).toBe(true)
        transactionSql.push(sql)
        const response = responses.shift()
        if (!response) throw new Error("Unexpected PostgreSQL statement")
        return response
      },
    }
    const pool = {
      unsafe: async () => {
        rootUnsafeCalls += 1
        throw new Error("Scoped reads must use their transaction client")
      },
      begin: async (...args: unknown[]) => {
        beginCalls.push(args)
        const run = args.at(-1) as (client: unknown) => Promise<unknown>
        transactionActive = true
        try {
          return await run(tx)
        } finally {
          transactionActive = false
        }
      },
    }
    const reader = new PgObjectStorage(pool as unknown as PgStoreClient).createReadScope({
      projectId,
      scope: selectedRoot,
      limits: { maxTraversalFacts: 10, maxVisibleJsonBytes: 1_000_000 },
    })

    const result = await reader.queryObjects?.({
      projectId,
      query: { kind: "start", objectTypeId: "Proposal" },
    })

    expect(result).toMatchObject({
      objects: [{ primaryId: "p1", properties: { id: "p1" } }],
      total: 1,
      hasMore: false,
    })
    expect(beginCalls).toHaveLength(1)
    expect(beginCalls[0]?.[0]).toBe("isolation level repeatable read")
    expect(transactionSql).toHaveLength(3)
    expect(rootUnsafeCalls).toBe(0)
    expect(responses).toHaveLength(0)
  })
})
