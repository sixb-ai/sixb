import { expect, test } from "bun:test"
import { PgMaterializationStateReader } from "../src/ontology-storage/materialization-state"
import { createPgClient, type SQLClient } from "../src/pg-client"

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}
function visits(node: PlanNode): number {
  return (
    (node["Relation Name"] === "ontology_replacement_work"
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0) + (node.Plans ?? []).reduce((total, child) => total + visits(child), 0)
  )
}

// Regression proof: restore materialization-state.ts before this fix. The nullable cursor OR
// cannot become an index bound in a generic plan, so each page rereads earlier identities.
test("replacement pages seek past the cursor in generic prepared plans", async () => {
  const sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName: "public",
    max: 1,
    statementTimeoutMillis: 10000,
  })
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL plan_cache_mode=force_generic_plan")
      // These temporary fixtures contain only the columns consumed by identity preparation.
      await tx.unsafe(
        "CREATE TEMP TABLE ontology_source_rows(project_id text,source_id text,materialization_id text,entity_kind text,object_type_id text,primary_id text) ON COMMIT DROP"
      )
      await tx.unsafe(
        "INSERT INTO ontology_source_rows SELECT 'test','source','candidate','object','Synthetic',lpad(i::text,5,'0') FROM generate_series(1,20000) i"
      )
      await tx.unsafe(
        'CREATE TEMP TABLE ontology_replacement_work(session_id text,entity_kind text,identity_key text COLLATE "C",sort_key text COLLATE "C",diff_required boolean,PRIMARY KEY(session_id,entity_kind,identity_key)) ON COMMIT DROP'
      )
      await tx.unsafe(
        "CREATE INDEX replacement_order ON ontology_replacement_work(session_id,entity_kind,sort_key,identity_key)"
      )
      let scanned = 0
      const observed = new Proxy(tx, {
        apply(target, thisArg, args: unknown[]) {
          const parts = args[0]
          if (
            !Array.isArray(parts) ||
            !parts.some(
              (part) =>
                typeof part === "string" &&
                part.includes("SELECT entity_kind, identity_key, sort_key, diff_required")
            )
          )
            return Reflect.apply(target, thisArg, args)
          return (async () => {
            const query = Reflect.apply(target, thisArg, args) as ReturnType<SQLClient["unsafe"]>
            const result = await query
            // EXPLAIN wrapped around a parameterized SELECT can plan its inner query with
            // concrete values. EXECUTE inspects the provider's actual prepared statement.
            const statement = Reflect.get(query, "statement") as { readonly name: string }
            const parameters = Reflect.get(query, "parameters") as readonly unknown[]
            const literals = parameters.map((value) => {
              if (value === null) return "NULL"
              if (typeof value !== "string" && typeof value !== "number")
                throw new Error("Unexpected pagination parameter")
              return `'${String(value).replaceAll("'", "''")}'`
            })
            const name = statement.name.replaceAll('"', '""')
            const rows = await target.unsafe(
              `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) EXECUTE "${name}"(${literals.join(",")})`
            )
            const plan = rows[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
            scanned += visits(plan[0]!.Plan)
            return result
          })()
        },
      })
      const reader = new PgMaterializationStateReader(observed, "test")
      const identities = []
      for await (const page of reader.replacementIdentities({
        sessionId: "session",
        sourceId: "source",
        candidateMaterializationId: "candidate",
        previousMaterializationId: null,
        kind: "object",
        pageRows: 1000,
      }))
        identities.push(...page)
      expect(identities).toHaveLength(20000)
      expect(identities[0]).toMatchObject({
        ref: { objectTypeId: "Synthetic", primaryId: "00001" },
      })
      expect(identities.at(-1)).toMatchObject({
        ref: { objectTypeId: "Synthetic", primaryId: "20000" },
      })
      expect(new Set(identities.map((identity) => identity.sortKey)).size).toBe(20000)
      expect(scanned).toBeLessThan(40000)
    })
  } finally {
    await sql.end()
  }
}, 30000)
