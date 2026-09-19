import { expect, test } from "bun:test"
import { PgOntologyOutboxStorage } from "../src/ontology-storage/outbox"
import { createPgClient, type SQLClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Subplan Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}
function visits(node: PlanNode): number {
  return (
    (node["Relation Name"] === "ontology_outbox"
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0) + (node.Plans ?? []).reduce((total, child) => total + visits(child), 0)
  )
}

function candidateVisits(node: PlanNode): number {
  if (node["Subplan Name"] === "CTE candidates") return visits(node)
  return (node.Plans ?? []).reduce((total, child) => total + candidateVisits(child), 0)
}

// Drop idx_ontology_outbox_publication_order after migration: claiming one batch then
// scans and sorts the entire ready backlog. Row visits avoid machine-dependent timing limits.
test("outbox selects a bounded candidate page from a large ready backlog", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({ connectionString: process.env.DATABASE_URL!, schemaName, max: 1 })
  const rollback = new Error("rollback synthetic claims")
  try {
    await sql.unsafe(`INSERT INTO ontology_outbox
      (project_id,id,commit_id,commit_ordinal,envelope,available_at,created_at,lease_id,lease_expires_at)
      SELECT 'test',i::text,'commit',i,jsonb_build_object('id',i::text,'type','object.created'),
        CASE WHEN i=1 THEN '2026-09-20'::timestamptz ELSE '2026-09-18'::timestamptz END,
        '2026-09-18'::timestamptz,CASE WHEN i IN (2,3) THEN 'previous' END,
        CASE WHEN i=2 THEN '2026-09-20'::timestamptz WHEN i=3 THEN '2026-09-18'::timestamptz END
      FROM generate_series(1,100000) i`)
    await sql.unsafe("ANALYZE ontology_outbox")
    await sql
      .begin(async (tx) => {
        let scanned = 0
        const observed = new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const parts = args[0]
            if (
              !Array.isArray(parts) ||
              !parts.some((part) => typeof part === "string" && part.includes("WITH candidates AS"))
            )
              return Reflect.apply(target, thisArg, args)
            return (async () => {
              const query = Reflect.apply(target, thisArg, args) as ReturnType<SQLClient["unsafe"]>
              const rows = await target`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`
              const plan = rows[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
              scanned = candidateVisits(plan[0]!.Plan)
              // EXPLAIN ANALYZE executed the claim; release its lease before testing returned rows.
              await target.unsafe(
                "UPDATE ontology_outbox SET lease_id=NULL,lease_expires_at=NULL WHERE lease_id='claim'"
              )
              return Reflect.apply(target, thisArg, args)
            })()
          },
        })
        const outbox = new PgOntologyOutboxStorage(async (run) => run(observed))
        const rows = await outbox.claim({
          projectId: "test",
          limit: 1000,
          now: "2026-09-19T00:00:00.000Z",
          leaseId: "claim",
          leaseExpiresAt: "2026-09-19T00:01:00.000Z",
        })
        expect(rows).toHaveLength(1000)
        expect(rows.map((row) => row.envelope.id)).toEqual(
          Array.from({ length: 1000 }, (_, i) => String(i + 3))
        )
        expect(scanned).toBeLessThan(10000)
        throw rollback
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error
      })
  } finally {
    await sql.end()
    await storage.dropSchema()
    await storage.close()
  }
}, 30000)
