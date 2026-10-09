import { expect, test } from "bun:test"
import { createPgClient } from "../src/pg-client"
import { PgRulesStorage } from "../src/pg-rules-storage"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage } from "./helpers"

interface PlanNode {
  readonly "Shared Hit Blocks": number
  readonly "Shared Read Blocks": number
}

// Regression proof: compare the cursor without `subject_kind` again. The index scan then starts
// at the cursor's rule rather than at the cursor, and every page re-reads the rule's earlier
// states. Buffer counts avoid machine-dependent timing limits.
test("rule state reconciliation pages start at their cursor", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
  try {
    await sql.unsafe(`INSERT INTO rule_states
      SELECT 'test', 'rule', 'object', 'Device', lpad(i::text, 6, '0'), '2026-10-07'
      FROM generate_series(1, 50000) i`)
    await sql.unsafe("ANALYZE rule_states")
    let blocks = 0
    const observed = new Proxy(sql, {
      get(target, property) {
        if (property !== "unsafe") return Reflect.get(target, property, target)
        return async (query: string, params: never[]) => {
          const [row] = await target.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${query}`,
            params
          )
          const { Plan } = (row?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[])[0]!
          blocks = Plan["Shared Hit Blocks"] + Plan["Shared Read Blocks"]
          return target.unsafe(query, params)
        }
      },
    }) as PgStoreClient

    const page = await new PgRulesStorage(observed).listReconciliationPage({
      projectId: "test",
      after: { ruleId: "rule", objectTypeId: "Device", primaryId: "049000" },
      limit: 500,
    })

    expect(page.states.map((state) => state.subject.primaryId).slice(0, 2)).toEqual([
      "049001",
      "049002",
    ])
    expect(blocks).toBeLessThan(50)
  } finally {
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 30000)
