import { describe, expect, test } from "bun:test"
import {
  linkRefSortKey,
  linkScopeSortKey,
  type OntologyLinkRef,
} from "@sixb/core/internal/materialization"
import { ProviderMaterializationTransactionLifecycle } from "@sixb/core/internal/ontology-storage-provider"
import type {
  MaterializationCardinalityOccupantWorkRecord,
  MaterializationPlanHeader,
  MaterializationWorkRecord,
} from "@sixb/core/storage"
import { PgOntologyMaterializationStorage } from "../src/ontology-storage/materializations"
import { jsonParameter } from "../src/ontology-storage/shared"
import { createPgClient, type SQL, type SQLClient } from "../src/pg-client"
import { createTestStorage } from "./helpers"

interface PlanNode {
  readonly "Relation Name"?: string
  readonly "Actual Rows"?: number
  readonly "Actual Loops"?: number
  readonly "Rows Removed by Filter"?: number
  readonly Plans?: readonly PlanNode[]
}

interface Observation {
  readonly plans: PlanNode[]
  analyses: number
}

const projectId = "cardinality-regression"
const timestamp = "2026-09-19T00:00:00.000Z"

function ref(index: number, target = "shared-user"): OntologyLinkRef {
  return {
    source: { objectTypeId: "Subscription", primaryId: `subscription-${index}` },
    linkId: "user",
    target: { objectTypeId: "User", primaryId: target },
  }
}

function occupant(
  value: OntologyLinkRef,
  occupied = true,
  view: "effective" | "candidate" = "effective"
): MaterializationCardinalityOccupantWorkRecord {
  return {
    kind: "cardinality",
    recordKey: `${view}:${linkRefSortKey(value)}`,
    view,
    ref: value,
    scopeSortKey: linkScopeSortKey(value.source, value.linkId),
    linkSortKey: linkRefSortKey(value),
    occupied,
  }
}

function header(id: string): MaterializationPlanHeader {
  return {
    commit: {
      projectId,
      id,
      executionId: `execution:${id}`,
      idempotencyKey: `key:${id}`,
      requestHash: `hash:${id}`,
      origin: { kind: "runtime", requestId: id },
      ontologyRevision: "test-ontology",
      intent: { kind: "edit", mode: "atomic", operationCount: 0 },
      committedAt: timestamp,
    },
    expected: { sources: [], objects: [], links: [], linkScopes: [], points: [] },
  }
}

/** Observe the provider's real query on its own transaction, without duplicating its SQL. */
function observe(sql: SQLClient, observation: Observation): SQLClient {
  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property !== "unsafe") return Reflect.get(target, property, receiver)
      return (...args: Parameters<SQLClient["unsafe"]>) => {
        const [query, parameters] = args
        if (query.startsWith("ANALYZE")) observation.analyses += 1
        if (!query.includes("WITH work AS")) return target.unsafe(...args)
        return (async () => {
          const explained = await target.unsafe(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${query}`,
            parameters
          )
          const result = explained[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
          if (!result[0]) throw new Error("Missing materialization query plan.")
          observation.plans.push(result[0].Plan)
          return target.unsafe(...args)
        })()
      }
    },
    apply(target, thisArg, args: unknown[]) {
      const strings = args[0]
      if (!Array.isArray(strings)) return Reflect.apply(target, thisArg, args)
      if (strings.some((part) => typeof part === "string" && part.includes("ANALYZE"))) {
        observation.analyses += 1
      }
      if (!strings.some((part) => typeof part === "string" && part.includes("WITH work AS"))) {
        return Reflect.apply(target, thisArg, args)
      }
      return (async () => {
        const query = Reflect.apply(target, thisArg, args) as ReturnType<typeof sql.unsafe>
        const explained = await sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${query}
        `
        const result = explained[0]?.["QUERY PLAN"] as readonly { readonly Plan: PlanNode }[]
        if (!result[0]) throw new Error("Missing materialization query plan.")
        observation.plans.push(result[0].Plan)
        return Reflect.apply(target, thisArg, args)
      })()
    },
  })
}

function linkVisits(node: PlanNode): number {
  const here =
    node["Relation Name"] === "links"
      ? ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0)
      : 0
  return here + (node.Plans ?? []).reduce((sum, child) => sum + linkVisits(child), 0)
}

async function withFixture(
  run: (fixture: {
    readonly sql: SQL
    readonly finalize: (
      tx: SQLClient,
      records: readonly MaterializationWorkRecord[],
      observation: Observation
    ) => Promise<void>
  }) => Promise<void>
): Promise<void> {
  const { storage, schemaName } = await createTestStorage()
  const sql = createPgClient({
    connectionString: process.env.DATABASE_URL!,
    schemaName,
    max: 1,
    statementTimeoutMillis: 15000,
  })
  let sequence = 0
  try {
    await run({
      sql,
      async finalize(tx, records, observation) {
        const id = `commit-${++sequence}`
        await storage.executions.create({
          id: `execution:${id}`,
          projectId,
          executor: { type: "request", requestId: id },
          source: { type: "http", requestId: id },
          correlationId: id,
          authorizationRef: { type: "disabled" },
        })
        const lifecycle = new ProviderMaterializationTransactionLifecycle()
        const materializations = new PgOntologyMaterializationStorage(observe(tx, observation), {
          id: {},
          active: true,
          materializations: lifecycle,
        })
        const session = await materializations.begin(header(id))
        for (let offset = 0; offset < records.length; offset += 1000) {
          await materializations.stageWork({
            session,
            records: records.slice(offset, offset + 1000),
          })
        }
        for await (const _page of materializations.streamWork({
          session,
          order: "cardinality",
          pageRows: 1000,
        })) {
          // Draining is required by the provider contract before finalization.
        }
        await materializations.finalize({
          session,
          finalization: {
            sourceActivations: [],
            result: {
              kind: "edit",
              commitId: id,
              created: true,
              eventCount: 0,
              committedAt: timestamp,
              outcomes: [],
              changes: { objects: [], links: [] },
            },
          },
        })
        lifecycle.assertCommittable()
      },
    })
  } finally {
    await sql.end({ timeout: 2 })
    await storage.dropSchema()
    await storage.close()
  }
}

async function insertLinks(
  sql: SQLClient,
  values: readonly OntologyLinkRef[],
  project = projectId
) {
  if (values.length === 0) return
  await sql`
    INSERT INTO links (
      project_id, source_type_id, source_id, link_id, target_type_id, target_id,
      properties, created_at, updated_at, last_commit_id
    )
    SELECT ${project}, value->'source'->>'objectTypeId', value->'source'->>'primaryId',
      value->>'linkId', value->'target'->>'objectTypeId', value->'target'->>'primaryId',
      '{}'::jsonb, ${timestamp}::timestamptz, ${timestamp}::timestamptz, 'test-commit'
    FROM jsonb_array_elements(${jsonParameter(sql, values)}::jsonb)
  `
}

function observation(): Observation {
  return { plans: [], analyses: 0 }
}

describe("PostgreSQL materialization final cardinality", () => {
  // Regression proof (PostgreSQL 17.10): restore materializations.ts before this fix and run
  // this file. The dense case visits 25,000,000 links, not <= 40,000; the sparse case also fails.
  // Keeping ANALYZE but restoring the JSON filter still fails the sparse case. These assertions
  // bound rows processed, not wall-clock time, and do not require a particular join algorithm.
  for (const [name, linkCount, scopeCount] of [
    ["dense first publication", 5000, 5000],
    ["few scopes among many new links", 20000, 100],
  ] as const) {
    test(name, async () => {
      await withFixture(async ({ sql, finalize }) => {
        const links = Array.from({ length: linkCount }, (_, index) => ref(index))
        await insertLinks(sql, links)
        await sql`DELETE FROM links`
        // Preserve allocated pages while recording an empty committed table, as in the incident.
        await sql`ANALYZE links`
        const records: MaterializationWorkRecord[] = links.slice(0, scopeCount).flatMap((value) => [
          occupant(value),
          occupant(value, true, "candidate"),
          {
            kind: "object-existence",
            recordKey: `exists:${value.source.primaryId}`,
            ref: value.source,
            exists: true,
          },
        ])
        const seen = observation()
        await sql.begin(async (tx) => {
          await insertLinks(tx, links)
          await finalize(tx, records, seen)
        })
        expect(seen.plans).toHaveLength(1)
        expect(linkVisits(seen.plans[0]!)).toBeLessThanOrEqual(4 * (linkCount + scopeCount))
        expect(await sql`SELECT count(*)::integer AS count FROM ontology_commits`).toMatchObject([
          { count: 1 },
        ])
      })
    }, 30000)
  }

  test("rare cardinality work with low statistics precision", async () => {
    await withFixture(async ({ sql, finalize }) => {
      const links = Array.from({ length: 20000 }, (_, index) => ref(index))
      await insertLinks(sql, links)
      await sql`DELETE FROM links`
      await sql`ANALYZE links`
      const records: MaterializationWorkRecord[] = links
        .slice(0, 100)
        .map((value) => occupant(value))
      for (let index = 0; index < 100000; index += 1) {
        records.push({
          kind: "object-existence",
          recordKey: `unrelated:${index}`,
          ref: { objectTypeId: "Unrelated", primaryId: String(index) },
          exists: true,
        })
      }
      const seen = observation()
      await sql.begin(async (tx) => {
        await tx`SET LOCAL default_statistics_target = 1`
        await tx`SET LOCAL work_mem = '64kB'`
        await insertLinks(tx, links)
        await finalize(tx, records, seen)
      })
      expect(seen.plans).toHaveLength(1)
      expect(linkVisits(seen.plans[0]!)).toBeLessThanOrEqual(4 * (links.length + 100))
    })
  }, 30000)

  const unusual: OntologyLinkRef = {
    source: { objectTypeId: "Abonné", primaryId: 'été/🎫\\"' },
    linkId: "utilisateur",
    target: { objectTypeId: "User", primaryId: '雪\\"' },
  }
  for (const scenario of [
    {
      name: "shared user, inactive occupant, and independent candidate view",
      actual: [ref(1), ref(2)],
      records: [
        occupant(ref(1)),
        occupant(ref(2)),
        occupant(ref(1, "old"), false),
        occupant(ref(1, "candidate-only"), true, "candidate"),
      ],
    },
    { name: "empty final scope", actual: [], records: [occupant(ref(1), false)] },
    { name: "Unicode and escaped identities", actual: [unusual], records: [occupant(unusual)] },
    {
      name: "missing expected link",
      actual: [],
      records: [occupant(ref(1))],
      error: "does not match",
    },
    {
      name: "wrong target",
      actual: [ref(1, "wrong")],
      records: [occupant(ref(1))],
      error: "does not match",
    },
    {
      name: "unexpected extra target",
      actual: [ref(1), ref(1, "extra")],
      records: [occupant(ref(1))],
      error: "does not match",
    },
    {
      name: "duplicate occupied scope",
      actual: [ref(1), ref(1, "extra")],
      records: [occupant(ref(1)), occupant(ref(1, "extra"))],
      error: "violates cardinality-one",
    },
    {
      name: "occupied link in an expected empty scope",
      actual: [ref(1)],
      records: [occupant(ref(1), false)],
      error: "does not match",
    },
  ]) {
    test(scenario.name, async () => {
      await withFixture(async ({ sql, finalize }) => {
        await insertLinks(sql, [ref(1, "other-project-target")], "another-project")
        const pending = sql.begin(async (tx) => {
          await insertLinks(tx, scenario.actual)
          await finalize(tx, scenario.records, observation())
        })
        if (scenario.error) {
          await expect(pending).rejects.toThrow(scenario.error)
          expect(
            await sql`SELECT count(*)::integer AS count FROM links WHERE project_id = ${projectId}`
          ).toMatchObject([{ count: 0 }])
          expect(await sql`SELECT count(*)::integer AS count FROM ontology_commits`).toMatchObject([
            { count: 0 },
          ])
        } else {
          await pending
          expect(await sql`SELECT count(*)::integer AS count FROM ontology_commits`).toMatchObject([
            { count: 1 },
          ])
        }
      })
    }, 15000)
  }

  test("skips statistics and link validation when no cardinality work exists", async () => {
    await withFixture(async ({ sql, finalize }) => {
      const seen = observation()
      await sql.begin((tx) => finalize(tx, [], seen))
      expect(seen.analyses).toBe(0)
      expect(seen.plans).toHaveLength(0)
    })
  }, 15000)

  test("reused connections retain no private table or prepared statement per session", async () => {
    await withFixture(async ({ sql, finalize }) => {
      for (let index = 0; index < 3; index += 1) {
        await sql.begin(async (tx) => {
          await insertLinks(tx, [ref(index)])
          await finalize(tx, [occupant(ref(index))], observation())
          expect(
            await tx`
            SELECT count(*)::integer AS count FROM pg_class
            WHERE relnamespace = pg_my_temp_schema() AND relname LIKE 'ontology_cardinality_%'
          `
          ).toMatchObject([{ count: 0 }])
        })
      }
      expect(
        await sql`
        SELECT count(*)::integer AS count FROM pg_prepared_statements
        WHERE statement LIKE '%ontology_cardinality_%'
          AND statement NOT LIKE '%pg_prepared_statements%'
          AND statement NOT LIKE '%pg_class%'
      `
      ).toMatchObject([{ count: 0 }])
    })
  }, 15000)
})
