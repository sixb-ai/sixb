import { expect, test } from "bun:test"
import { ProviderMaterializationTransactionLifecycle } from "@sixb/core/internal/ontology-storage-provider"
import type { MaterializationWorkRecord } from "@sixb/core/storage"
import { PgOntologyMaterializationStorage } from "../src/ontology-storage/materializations"
import { createPgClient, type SQLClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}

function visitedRows(node: PlanNode): number {
  return (
    (node["Relation Name"] === "ontology_materialization_work"
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0) + (node.Plans ?? []).reduce((total, child) => total + visitedRows(child), 0)
  )
}

// Restore materialization-session.ts before this fix: the first lookup scans the mixed work
// population. Count actual rows visited so the regression does not depend on machine speed.
test("existence lookup seeks requested keys without scanning mixed work", async () => {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName,
    max: 1,
    statementTimeoutMillis: 15000,
  })
  const rollback = new Error("rollback synthetic work")
  const projectId = "existence-performance"
  const id = "existence-performance"
  try {
    await storage.executions.create({
      id,
      projectId,
      executor: { type: "request", requestId: id },
      source: { type: "http", requestId: id },
      correlationId: id,
      authorizationRef: { type: "disabled" },
    })
    await sql
      .begin(async (tx) => {
        const plans: PlanNode[] = []
        const observed = new Proxy(tx, {
          apply(target, thisArg, args: unknown[]) {
            const parts = args[0]
            if (
              !Array.isArray(parts) ||
              !parts.some(
                (part) => typeof part === "string" && /SELECT (work\.)?unique_key,/.test(part)
              )
            )
              return Reflect.apply(target, thisArg, args)
            return (async () => {
              const query = Reflect.apply(target, thisArg, args) as ReturnType<SQLClient["unsafe"]>
              const rows = await target`EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`
              const plan = rows[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
              plans.push(plan[0]!.Plan)
              return Reflect.apply(target, thisArg, args)
            })()
          },
        })
        const materializations = new PgOntologyMaterializationStorage(observed, {
          id: {},
          active: true,
          materializations: new ProviderMaterializationTransactionLifecycle(),
        })
        const session = await materializations.begin({
          commit: {
            projectId,
            id,
            executionId: id,
            idempotencyKey: id,
            requestHash: id,
            origin: { kind: "runtime", requestId: id },
            executor: { type: "request", requestId: id },
            ontologyRevision: "test",
            intent: { kind: "edit", mode: "atomic", operationCount: 0 },
            committedAt: "2026-09-19T00:00:00.000Z",
          },
          expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
        })
        for (let offset = 0; offset < 100000; offset += 1000) {
          const records: MaterializationWorkRecord[] = Array.from({ length: 1000 }, (_, index) => {
            const i = offset + index
            const ref = { objectTypeId: "Synthetic", primaryId: String(i) }
            return i % 5 === 0
              ? { kind: "object-existence", recordKey: `exists:${i}`, ref, exists: i % 10 === 0 }
              : {
                  kind: "classification",
                  recordKey: `classification:${i}`,
                  entityKind: "object",
                  identityKey: String(i),
                }
          })
          await materializations.stageWork({ session, records })
        }
        const refs = Array.from({ length: 1000 }, (_, i) => ({
          objectTypeId: "Synthetic",
          primaryId: String(i),
        }))
        const result = await materializations.readObjectExistence({ session, refs })
        expect(result).toEqual(
          refs
            .filter((_, i) => i % 5 === 0)
            .map((ref) => ({ ref, exists: Number(ref.primaryId) % 10 === 0 }))
        )
        expect(plans).toHaveLength(1)
        expect(visitedRows(plans[0]!)).toBeLessThan(10000)
        expect(
          await materializations.readObjectExistence({
            session,
            refs: [refs[0]!, refs[0]!, { objectTypeId: "Absent", primaryId: "absent" }],
          })
        ).toEqual([
          { ref: refs[0]!, exists: true },
          { ref: refs[0]!, exists: true },
        ])
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
