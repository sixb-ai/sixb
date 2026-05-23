import { describe, expect, test } from "bun:test"
import { col, type DatasetColumnType, LakeStorageError } from "@sixb/core"
import {
  datasetColumnToDuckDbSql,
  datasetColumnTypeToDuckDbSql,
  datasetSchemaToDuckDbColumnsSql,
  duckDbColumnsToDatasetSchema,
  duckDbTypeToDatasetColumnType,
  FILE_REF_STRUCT_SQL,
} from "../src/internal/schema"

describe("DuckLake schema mapping", () => {
  test("maps Sixb column types to DuckDB SQL types", () => {
    const expected: Readonly<Record<DatasetColumnType, string>> = {
      string: "VARCHAR",
      boolean: "BOOLEAN",
      int64: "BIGINT",
      float64: "DOUBLE",
      decimal: "DECIMAL(38, 9)",
      date: "DATE",
      timestamp: "TIMESTAMPTZ",
      json: "JSON",
      fileRef: FILE_REF_STRUCT_SQL,
    }

    for (const [type, sql] of Object.entries(expected)) {
      expect(datasetColumnTypeToDuckDbSql(type as DatasetColumnType)).toBe(sql)
    }
  })

  test("creates nullable and not-null column definitions", () => {
    expect(datasetColumnToDuckDbSql(col("orderId", "string"))).toBe('"orderId" VARCHAR NOT NULL')
    expect(datasetColumnToDuckDbSql(col("attachment", "fileRef", { nullable: true }))).toBe(
      `"attachment" ${FILE_REF_STRUCT_SQL}`
    )
  })

  test("creates a full DuckDB column list for a dataset schema", () => {
    expect(
      datasetSchemaToDuckDbColumnsSql({
        columns: [
          col("orderId", "string"),
          col("amount", "decimal"),
          col("metadata", "json", { nullable: true }),
        ],
      })
    ).toBe('"orderId" VARCHAR NOT NULL, "amount" DECIMAL(38, 9) NOT NULL, "metadata" JSON')
  })

  test("maps DuckDB metadata back to a Sixb schema", () => {
    expect(
      duckDbColumnsToDatasetSchema([
        { name: "orderId", type: "VARCHAR", nullable: false },
        { name: "isOpen", type: "BOOLEAN", nullable: false },
        { name: "count", type: "BIGINT", nullable: false },
        { name: "score", type: "DOUBLE", nullable: false },
        { name: "amount", type: "DECIMAL(38,9)", nullable: false },
        { name: "orderDate", type: "DATE", nullable: false },
        { name: "createdAt", type: "TIMESTAMP WITH TIME ZONE", nullable: false },
        { name: "metadata", type: "JSON", nullable: true },
        { name: "attachment", type: FILE_REF_STRUCT_SQL, nullable: true },
      ])
    ).toEqual({
      columns: [
        { name: "orderId", type: "string" },
        { name: "isOpen", type: "boolean" },
        { name: "count", type: "int64" },
        { name: "score", type: "float64" },
        { name: "amount", type: "decimal" },
        { name: "orderDate", type: "date" },
        { name: "createdAt", type: "timestamp" },
        { name: "metadata", type: "json", nullable: true },
        { name: "attachment", type: "fileRef", nullable: true },
      ],
    })
  })

  test("recognizes fileRef only from the exact Sixb struct shape", () => {
    expect(duckDbTypeToDatasetColumnType("JSON")).toBe("json")
    expect(() =>
      duckDbTypeToDatasetColumnType("STRUCT(blobId VARCHAR, digest VARCHAR, extra VARCHAR)")
    ).toThrow(LakeStorageError)
  })

  test("rejects unknown DuckDB types with an actionable error", () => {
    expect(() => duckDbTypeToDatasetColumnType("INTEGER")).toThrow(
      "cannot be mapped to a Sixb dataset column type"
    )
  })
})
