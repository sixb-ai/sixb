import { describe, expect, test } from "bun:test"
import {
  arrayLen,
  extractObjects,
  formatValue,
  metaLine,
  namedItems,
  numberField,
  numberOr,
  pickColumns,
  runTiming,
  seriesUnit,
  singleObject,
  stringField,
  toSeriesData,
} from "../src/bash/data"

describe("extractObjects", () => {
  test("reads both the bare-array and { objects } envelopes", () => {
    expect(extractObjects([{ primaryId: "a" }, "skip", { primaryId: "b" }])).toEqual([
      { primaryId: "a" },
      { primaryId: "b" },
    ])
    expect(extractObjects({ objects: [{ primaryId: "a" }], total: 1 })).toEqual([
      { primaryId: "a" },
    ])
  })

  test("returns null when there are no objects to read", () => {
    expect(extractObjects({ count: 3 })).toBeNull()
    expect(extractObjects("nope")).toBeNull()
  })
})

describe("singleObject", () => {
  test("unwraps the { object } envelope and falls back to a bare record", () => {
    expect(singleObject({ object: { primaryId: "a" } })).toEqual({ primaryId: "a" })
    expect(singleObject({ primaryId: "b" })).toEqual({ primaryId: "b" })
    expect(singleObject(42)).toBeNull()
  })
})

describe("pickColumns", () => {
  test("ranks by population, skips identity echoes, and caps at five", () => {
    const objects = [
      { properties: { id: "x", primaryId: "x", a: 1, b: 2, c: 3 } },
      { properties: { a: 1, b: 2, d: 4, e: 5, f: 6 } },
      { properties: { a: 1, b: 2, c: 3, g: 7 } },
    ]
    const columns = pickColumns(objects)
    expect(columns).not.toContain("id")
    expect(columns).not.toContain("primaryId")
    // a and b appear in every row, so they lead; the column list never exceeds five.
    expect(columns.slice(0, 2)).toEqual(["a", "b"])
    expect(columns.length).toBeLessThanOrEqual(5)
  })
})

describe("toSeriesData", () => {
  test("keeps finite, timestamped points and sorts them oldest→newest", () => {
    const data = toSeriesData([
      { value: 3, at: "2026-01-03T00:00:00.000Z" },
      { value: 1, at: "2026-01-01T00:00:00.000Z" },
      { value: Number.NaN, at: "2026-01-02T00:00:00.000Z" },
      { value: 2, at: "" },
      { value: "nope", at: "2026-01-04T00:00:00.000Z" },
    ])
    expect(data).toEqual([
      { value: 1, timestamp: "2026-01-01T00:00:00.000Z" },
      { value: 3, timestamp: "2026-01-03T00:00:00.000Z" },
    ])
  })

  test("returns an empty series for non-array input", () => {
    expect(toSeriesData(undefined)).toEqual([])
  })
})

describe("seriesUnit", () => {
  test("takes the first declared unit", () => {
    expect(seriesUnit([{ value: 1 }, { value: 2, unit: "rpm" }])).toBe("rpm")
    expect(seriesUnit([{ value: 1 }])).toBeUndefined()
  })
})

describe("runTiming", () => {
  test("prefers finished, then started, then queued", () => {
    expect(runTiming({ finishedAt: "2026-01-01T00:00:00.000Z", startedAt: "x" })).toMatch(
      /^finished /
    )
    expect(runTiming({ startedAt: "2026-01-01T00:00:00.000Z" })).toMatch(/^started /)
    expect(runTiming({ queuedAt: "2026-01-01T00:00:00.000Z" })).toMatch(/^queued /)
    expect(runTiming({})).toBe("")
  })
})

describe("namedItems", () => {
  test("names each item and picks target → semanticType → telemetry mode for the meta hint", () => {
    expect(
      namedItems([
        { name: "owner", targetObjectTypeId: "customer" },
        { id: "temperature", semanticType: "celsius" },
        { name: "rpm", mode: "telemetry" },
        { name: "plain" },
      ])
    ).toEqual([
      { name: "owner", meta: "customer" },
      { name: "temperature", meta: "celsius" },
      { name: "rpm", meta: "telemetry" },
      { name: "plain", meta: undefined },
    ])
    expect(namedItems("nope")).toEqual([])
  })
})

describe("scalar helpers", () => {
  test("metaLine drops zero counts and pluralizes", () => {
    expect(
      metaLine([
        [3, "property", "properties"],
        [0, "link", "links"],
        [1, "action", "actions"],
      ])
    ).toBe("3 properties · 1 action")
  })

  test("stringField / numberField read typed fields", () => {
    expect(stringField({ a: "x", b: 1 }, "a")).toBe("x")
    expect(stringField({ b: 1 }, "b")).toBeUndefined()
    expect(numberField({ n: 5 }, "n")).toBe(5)
    expect(numberField({ n: "5" }, "n")).toBeNull()
    expect(numberField("nope", "n")).toBeNull()
  })

  test("numberOr / arrayLen / formatValue", () => {
    expect(numberOr(4, 0)).toBe(4)
    expect(numberOr("x", 9)).toBe(9)
    expect(arrayLen([1, 2])).toBe(2)
    expect(arrayLen("nope")).toBe(0)
    expect(formatValue("")).toBe("—")
    expect(formatValue(true)).toBe("Yes")
    expect(formatValue(1000)).toBe((1000).toLocaleString())
  })
})
