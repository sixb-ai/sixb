import { describe, expect, test } from "bun:test"
import { LakeStorageError } from "@pario/core"
import { renderDuckLakeSqlTransformSql } from "../src/internal/sql-transform-relations"

describe("DuckLake SQL transform relations", () => {
  test("renders provider-owned DuckLake time-travel relations", () => {
    const sql = renderDuckLakeSqlTransformSql({
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
      'select * from (SELECT * FROM "lake".main."pario__ds__raw__crm__customers" AT (VERSION => 42)) c'
    )
  })

  test("keeps physical table names hidden while user SQL is constructed", () => {
    let placeholder = ""

    const sql = renderDuckLakeSqlTransformSql({
      options: {},
      sources: {
        orders: {
          datasetId: "raw.erp.orders",
          versionId: "ducklake:7",
        },
      },
      sql: ({ orders }) => {
        placeholder = String(orders)
        expect(placeholder).toStartWith("__pario_sql_transform_relation_")
        expect(placeholder).not.toContain("pario__ds__raw__erp__orders")
        return `select * from ${orders}`
      },
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "pario_lake".main."pario__ds__raw__erp__orders" AT (VERSION => 7))'
    )
    expect(sql).not.toContain(placeholder)
  })

  test("does not render source names into SQL relation handles", () => {
    const sourceName = "customers; drop table target"

    const sql = renderDuckLakeSqlTransformSql({
      options: {},
      sources: {
        [sourceName]: {
          datasetId: "raw.crm.customers",
          versionId: "ducklake:8",
        },
      },
      sql: (relations) => `select * from ${relations[sourceName]}`,
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "pario_lake".main."pario__ds__raw__crm__customers" AT (VERSION => 8))'
    )
    expect(sql).not.toContain(sourceName)
  })

  test("supports relation names that would otherwise touch object prototypes", () => {
    const sourceName = "__proto__"

    const sql = renderDuckLakeSqlTransformSql({
      options: {},
      sources: {
        [sourceName]: {
          datasetId: "raw.crm.customers",
          versionId: "ducklake:9",
        },
      },
      sql: (relations) => `select * from ${relations[sourceName]}`,
    })

    expect(sql).toBe(
      'select * from (SELECT * FROM "pario_lake".main."pario__ds__raw__crm__customers" AT (VERSION => 9))'
    )
  })

  test("rejects fake relation placeholders", () => {
    expect(() =>
      renderDuckLakeSqlTransformSql({
        options: {},
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
      renderDuckLakeSqlTransformSql({
        options: {},
        sources: {},
        sql: () => "select * from __pario_sql_transform_relation_not_real__",
      })
    ).toThrow("unresolved relation placeholder")
  })
})
