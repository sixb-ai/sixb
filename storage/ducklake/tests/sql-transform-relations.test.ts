import { describe, expect, test } from "bun:test"
import { col, defineDataset } from "@sixb/core"
import { LakeStorageError, type SqlTransformBody } from "@sixb/core/lake-storage"
import type { DuckLakeStorageOptions } from "../src"
import {
  createDuckLakeSqlTransformTemplate,
  type DuckLakeSqlTransformSourceRelation,
  pickSourceColumns,
  renderDuckLakeSourceRelations,
} from "../src/internal/sql-transform-relations"

function renderOnLake(input: {
  readonly options?: Pick<DuckLakeStorageOptions, "alias">
  readonly sources: Readonly<Record<string, DuckLakeSqlTransformSourceRelation>>
  readonly sql: SqlTransformBody<"duckdb">
}): string {
  return createDuckLakeSqlTransformTemplate(Object.keys(input.sources), input.sql).render(
    renderDuckLakeSourceRelations(input.options ?? {}, input.sources)
  )
}

describe("DuckLake SQL transform relations", () => {
  test("renders provider-owned DuckLake time-travel relations", () => {
    const sql = renderOnLake({
      options: { alias: "lake" },
      sources: {
        customers: {
          datasetId: "raw.crm.customers",
          versionId: "ducklake:42",
        },
      },
      sql: ({ customers }) => `select * from ${customers} c`,
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "lake".main."sixb__ds__raw__crm__customers" AT (VERSION => 42)) c'
    )
  })

  test("renders a pick as the only columns of the relation", () => {
    const sql = renderOnLake({
      sources: {
        orders: {
          datasetId: "raw.erp.orders",
          versionId: "ducklake:3",
          columns: ["orderId", "amount"],
        },
      },
      sql: ({ orders }) => `select * from ${orders}`,
    })

    expect(sql).toBe(
      'select * from (SELECT "orderId", "amount" FROM "sixb_lake".main."sixb__ds__raw__erp__orders" AT (VERSION => 3))'
    )
  })

  test("calls the transform body once and renders it against several relation sets", () => {
    let calls = 0
    const template = createDuckLakeSqlTransformTemplate(["orders"], ({ orders }) => {
      calls += 1
      return `select count(*) from ${orders} join ${orders} using (id)`
    })

    expect(template.render(new Map([["orders", "lake_orders"]]))).toBe(
      "select count(*) from lake_orders join lake_orders using (id)"
    )
    expect(template.render(new Map([["orders", "analysis_orders"]]))).toBe(
      "select count(*) from analysis_orders join analysis_orders using (id)"
    )
    expect(calls).toBe(1)
  })

  test("keeps physical table names hidden while user SQL is constructed", () => {
    let placeholder = ""

    const sql = renderOnLake({
      sources: {
        orders: {
          datasetId: "raw.erp.orders",
          versionId: "ducklake:7",
        },
      },
      sql: ({ orders }) => {
        placeholder = String(orders)
        expect(placeholder).toStartWith("__sixb_sql_transform_relation_")
        expect(placeholder).not.toContain("sixb__ds__raw__erp__orders")
        return `select * from ${orders}`
      },
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "sixb_lake".main."sixb__ds__raw__erp__orders" AT (VERSION => 7))'
    )
    expect(sql).not.toContain(placeholder)
  })

  // A source name reaches neither the SQL nor an object prototype.
  test.each([
    "customers; drop table target",
    "__proto__",
  ])("renders source %p only as its relation", (sourceName) => {
    const sql = renderOnLake({
      sources: {
        [sourceName]: {
          datasetId: "raw.crm.customers",
          versionId: "ducklake:8",
        },
      },
      sql: (relations) => `select * from ${relations[sourceName]}`,
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "sixb_lake".main."sixb__ds__raw__crm__customers" AT (VERSION => 8))'
    )
    expect(sql).not.toContain(sourceName)
  })

  test("rejects fake relation placeholders", () => {
    expect(() =>
      renderOnLake({
        sources: {
          customers: {
            datasetId: "raw.crm.customers",
            versionId: "ducklake:42",
          },
        },
        sql: ({ customers }) => `select * from ${String(customers).replace("_0__", "_1__")}`,
      })
    ).toThrow(LakeStorageError)
  })

  test("rejects malformed unresolved relation placeholders", () => {
    expect(() =>
      renderOnLake({
        sources: {},
        sql: () => "select * from __sixb_sql_transform_relation_not_real__",
      })
    ).toThrow("unresolved relation placeholder")
  })

  test("validates picks against the source definition", () => {
    const orders = defineDataset("raw.erp.orders", {
      schema: [col("orderId", "string"), col("amount", "decimal")],
    })

    expect(pickSourceColumns("orders", orders).map((column) => column.name)).toEqual([
      "orderId",
      "amount",
    ])
    expect(pickSourceColumns("orders", orders, ["amount"]).map((column) => column.name)).toEqual([
      "amount",
    ])
    expect(() => pickSourceColumns("orders", orders, ["Amount"])).toThrow(
      "[SixbDuckLake] SQL transform source 'orders' picks column 'Amount', which dataset 'raw.erp.orders' does not have."
    )
    expect(() => pickSourceColumns("orders", orders, ["amount", "amount"])).toThrow(
      "picks column 'amount' more than once"
    )
    expect(() => pickSourceColumns("orders", orders, [])).toThrow("must pick at least one column")
  })
})
