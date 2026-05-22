import { describe, expect, test } from "bun:test"
import { LakeStorageError } from "@pario/core"
import {
  DATASET_TABLE_PREFIX,
  decodeDatasetTableName,
  encodeDatasetTableName,
} from "../src/internal/names"

describe("DuckLake dataset table names", () => {
  test("uses compact names for common lowercase dotted dataset ids", () => {
    expect(encodeDatasetTableName("raw.erp.orders")).toBe(`${DATASET_TABLE_PREFIX}raw__erp__orders`)
  })

  test("round-trips ids without collisions", () => {
    const ids = [
      "raw.erp.orders",
      "raw_erp.orders",
      "raw..erp.orders",
      "raw.erp_orders",
      "Raw.ERP.orders",
      "raw/erp/orders",
      "raw.erp.orders.v2",
      "raw.erp.orders-é",
      "a__b",
      "a.b",
      "a_b",
    ]

    const encodedNames = new Set<string>()
    for (const id of ids) {
      const tableName = encodeDatasetTableName(id)

      expect(tableName).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      expect(decodeDatasetTableName(tableName)).toBe(id)
      expect(encodedNames.has(tableName)).toBe(false)
      encodedNames.add(tableName)
    }
  })

  test("filters provider tables to dataset tables", () => {
    expect(decodeDatasetTableName(`${DATASET_TABLE_PREFIX}raw__erp__orders`)).toBe("raw.erp.orders")
    expect(decodeDatasetTableName("pario__sys__snapshots")).toBeNull()
    expect(decodeDatasetTableName("orders")).toBeNull()
  })

  test("rejects invalid encoded table names", () => {
    expect(decodeDatasetTableName(DATASET_TABLE_PREFIX)).toBeNull()
    expect(decodeDatasetTableName(`${DATASET_TABLE_PREFIX}raw_`)).toBeNull()
    expect(decodeDatasetTableName(`${DATASET_TABLE_PREFIX}raw_gg`)).toBeNull()
    expect(decodeDatasetTableName(`${DATASET_TABLE_PREFIX}raw-erp`)).toBeNull()
  })

  test("rejects empty dataset ids", () => {
    expect(() => encodeDatasetTableName("")).toThrow(LakeStorageError)
    expect(() => encodeDatasetTableName(" ")).toThrow("Dataset id must not be empty")
  })
})
