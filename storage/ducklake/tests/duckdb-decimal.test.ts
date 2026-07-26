import { describe, expect, test } from "bun:test"
import { decimal } from "@sixb/core"
import { LakeStorageError } from "@sixb/core/lake-storage"
import { DUCKDB_COLUMN_TYPES } from "../src/internal/duckdb-column-types"
import { normalizeDuckDbDecimalValue } from "../src/internal/duckdb-decimal"

describe("DuckDB decimal values", () => {
  test("normalizes values that fit exactly in the physical decimal type", () => {
    expect(DUCKDB_COLUMN_TYPES.decimal.sql).toBe("DECIMAL(38, 9)")
    expect(normalizeDuckDbDecimalValue("+0001.2300000000", "amount")).toBe(decimal("1.23"))
    expect(normalizeDuckDbDecimalValue("99999999999999999999999999999.999999999", "amount")).toBe(
      decimal("99999999999999999999999999999.999999999")
    )
    expect(normalizeDuckDbDecimalValue("-0.000000001", "amount")).toBe(decimal("-0.000000001"))
  })

  test("rejects values DuckDB would round or overflow", () => {
    expect(() => normalizeDuckDbDecimalValue("0.1234567891", "amount")).toThrow(
      "cannot be represented exactly as DECIMAL(38, 9)"
    )
    expect(() => normalizeDuckDbDecimalValue("999999999999999999999999999999", "amount")).toThrow(
      "cannot be represented exactly as DECIMAL(38, 9)"
    )
  })

  test("rejects invalid runtime values with a provider error", () => {
    expect(() => normalizeDuckDbDecimalValue(1.25, "amount")).toThrow(LakeStorageError)
    expect(() => normalizeDuckDbDecimalValue("not-a-decimal", "amount")).toThrow(
      "must be an exact decimal string"
    )
  })
})
