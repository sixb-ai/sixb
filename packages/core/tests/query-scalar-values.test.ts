import { describe, expect, test } from "bun:test"
import {
  compareQueryScalarValues,
  queryScalarValuesEqual,
} from "../src/objects/query/scalar-values"

describe("query scalar value semantics", () => {
  test("dispatches ordering by the resolved scalar kind", () => {
    expect(compareQueryScalarValues("10", "2", "string")).toBeLessThan(0)
    expect(compareQueryScalarValues("a", "b", "uuid")).toBeLessThan(0)
    expect(compareQueryScalarValues(false, true, "boolean")).toBeLessThan(0)
    expect(compareQueryScalarValues(10, 2, "integer")).toBeGreaterThan(0)
    expect(compareQueryScalarValues(1.5, 2.5, "double")).toBeLessThan(0)
    expect(compareQueryScalarValues("10", "2", "decimal")).toBeGreaterThan(0)
    expect(compareQueryScalarValues("2026-01-02", "2026-01-01", "date")).toBeGreaterThan(0)
    expect(
      compareQueryScalarValues(
        new Date("2026-01-01T00:00:00.000Z"),
        "2026-01-01T00:00:00.000Z",
        "timestamp"
      )
    ).toBe(0)
  })

  test("keeps decimal equality numeric and rejects representation mismatches", () => {
    expect(queryScalarValuesEqual("1.00", "1", "decimal")).toBe(true)
    expect(queryScalarValuesEqual("1", "1", "string")).toBe(true)
    expect(queryScalarValuesEqual("1", 1, "integer")).toBe(false)
    expect(compareQueryScalarValues("1", 1, "decimal")).toBeNaN()
  })
})
