import { describe, expect, test } from "bun:test"
import { normalizeProjectedValue } from "../src/projection-value-coercion"

describe("projection value coercion", () => {
  test("preserves exact decimal strings without converting through Number", () => {
    expect(
      normalizeProjectedValue({
        columnType: "decimal",
        schema: "decimal",
        value: "09007199254740993.0100",
      })
    ).toEqual({ ok: true, value: "9007199254740993.01" })
  })

  test("maps exact int64 strings and bigints to decimal strings", () => {
    expect(
      normalizeProjectedValue({
        columnType: "int64",
        schema: "decimal",
        value: "9007199254740993",
      })
    ).toEqual({ ok: true, value: "9007199254740993" })
    expect(
      normalizeProjectedValue({
        columnType: "int64",
        schema: "decimal",
        value: 9_007_199_254_740_993n,
      })
    ).toEqual({ ok: true, value: "9007199254740993" })
  })

  test("rejects JS numbers from decimal columns because their precision is unknowable", () => {
    expect(
      normalizeProjectedValue({ columnType: "decimal", schema: "decimal", value: 1.1 })
    ).toEqual({
      ok: false,
      errorMessage: "cannot safely coerce value 1.1 to an exact decimal",
    })
  })

  test("still permits explicitly lossy decimal-to-double projections", () => {
    expect(
      normalizeProjectedValue({ columnType: "decimal", schema: "double", value: "1.25" })
    ).toEqual({ ok: true, value: 1.25 })
  })
})
