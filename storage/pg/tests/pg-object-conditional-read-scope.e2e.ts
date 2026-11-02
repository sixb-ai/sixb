import { describe, expect, test } from "bun:test"
import type { ObjectQuery } from "@sixb/core"
import { compileConditionalObjectReadScope } from "@sixb/core/storage"
import type { PostgresStorage } from "../src"
import { compilePgObjectQuery } from "../src/objects/query-compiler"
import { compilePgConditionalObjectReadSource } from "../src/objects/read-scope"
import type { SQL, SqlParameter } from "../src/pg-client"
import { createTestStorage, disposeTestStorage } from "./helpers"

const projectId = "pg-conditional-reader"
const Customer = "PgConditionCustomer"
const Invoice = "PgConditionInvoice"

const source = compilePgConditionalObjectReadSource(
  projectId,
  compileConditionalObjectReadScope({
    kind: "conditional",
    conditions: [
      {
        objectTypeId: Invoice,
        predicate: { op: "eq", propertyId: "status", value: "paid", scalarKind: "string" },
      },
    ],
  })
)

describe("PgObjectStorage conditional reader plans", () => {
  test("inlines the conditional relations instead of materializing them", async () => {
    // Removal proof: drop `NOT MATERIALIZED`. A traversal reads the visible objects three times,
    // so PostgreSQL materializes them: a CTE Scan over every visible object of the project.
    await withInvoices(async (sql) => {
      const plan = await explain(sql, {
        kind: "traverse",
        direction: "outgoing",
        linkId: "invoices",
        input: { kind: "refs", refs: [{ objectTypeId: Customer, primaryId: "cust-1" }] },
      })

      expect(plan).not.toContain("CTE Scan")
    })
  })

  test("reads a conditioned type with its condition where an index can serve it", async () => {
    // Removal proof: drop the source's `objectsOfType`. The condition then sits inside the
    // disjunction over every conditioned type, which no index on its property can serve.
    await withInvoices(async (sql) => {
      await sql.unsafe(`
        CREATE INDEX conditional_invoice_status
        ON objects ((md5(properties ->> 'status')))
        WHERE project_id = '${projectId}' AND object_type_id = '${Invoice}'
      `)
      await sql.unsafe("ANALYZE objects")

      const plan = await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL enable_seqscan = off")
        return explain(tx, { kind: "start", objectTypeId: Invoice }, "total")
      })

      // The index on the parent reaches the partition under a generated name.
      expect(plan).toMatch(/Index Scan using objects_default_\w+ on objects_default/)
      expect(plan).toContain("Index Cond: (md5(")
    })
  })
})

async function withInvoices(run: (sql: SQL) => Promise<void>): Promise<void> {
  const { storage } = await createTestStorage()
  try {
    const sql = sqlOf(storage)
    await sql.unsafe(
      `
        INSERT INTO objects (
          project_id, object_type_id, primary_id, properties,
          created_at, updated_at, version, last_commit_id
        )
        SELECT $1, $2, 'inv-' || i,
          jsonb_build_object('status', CASE WHEN i = 1 THEN 'paid' ELSE 'draft' END),
          now(), now(), 1, 'conditional-test'
        FROM generate_series(1, 500) AS i
      `,
      [projectId, Invoice]
    )
    await sql.unsafe(
      `
        INSERT INTO links (
          project_id, source_type_id, source_id, link_id, target_type_id, target_id,
          created_at, updated_at, last_commit_id
        )
        SELECT $1, $2, 'cust-1', 'invoices', $3, 'inv-' || i, now(), now(), 'conditional-test'
        FROM generate_series(1, 500) AS i
      `,
      [projectId, Customer, Invoice]
    )
    await sql.unsafe("ANALYZE objects")
    await sql.unsafe("ANALYZE links")

    await run(sql)
  } finally {
    await disposeTestStorage(storage)
  }
}

async function explain(
  sql: Pick<SQL, "unsafe">,
  query: ObjectQuery,
  statement: "rows" | "total" = "rows"
): Promise<string> {
  const compiled = compilePgObjectQuery(projectId, query, { source })
  const [text, args] =
    statement === "rows" ? [compiled.sql, compiled.args] : [compiled.totalSql, compiled.totalArgs]
  const rows = await sql.unsafe<{ "QUERY PLAN": string }[]>(
    `EXPLAIN ${text}`,
    args as SqlParameter[]
  )

  return rows.map((row) => row["QUERY PLAN"]).join("\n")
}

function sqlOf(storage: PostgresStorage): SQL {
  return (storage as unknown as { sql: SQL }).sql
}
