import { describe, expect, test } from "bun:test"
import { decodeLineage, encodeLineage } from "../src/internal/lineage-encoding"

const ref = (datasetId: string, column: string) => ({ datasetId, column })
const unreadable = { unknown: "a version of 'analytics' records a column lineage Sixb cannot read" }

describe("DuckLake lineage encoding", () => {
  test("decodes what it encodes, exactly", () => {
    const lineage = {
      rows: [ref("raw.orders", "tenant"), ref("raw.orders", "customerId")],
      columns: {
        ["__proto__"]: [ref("raw.orders", "id")],
        amount: [ref("raw.fx", "rate"), ref("raw.orders", "amount")],
        note: [],
      },
    }
    for (const value of [lineage, { rows: [], columns: {} }, { unknown: "lost upstream" }]) {
      expect(decodeLineage("analytics", encodeLineage(value))).toEqual(value)
    }
    const decoded = decodeLineage("analytics", encodeLineage(lineage))
    expect("columns" in decoded && Object.keys(decoded.columns)).toEqual([
      "__proto__",
      "amount",
      "note",
    ])
  })

  test("stores each dataset id and column name once", () => {
    const wide = {
      rows: [],
      columns: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `column_${index}`,
          [ref("upstream.wide_source", "amount"), ref("upstream.wide_source", "currency")],
        ])
      ),
    }

    expect(encodeLineage(wide).length).toBeLessThan(JSON.stringify(wide).length / 4)
  })

  // Regression proof: drop a lineage that does not decode instead. A version outside pipelines
  // then reads as depending on its own columns only, and loses the markings of its sources.
  test("reads a lineage it cannot decode as unknown", () => {
    const valid = JSON.parse(encodeLineage({ rows: [ref("raw", "id")], columns: { id: [] } }))
    const malformed = [
      undefined,
      42,
      { v: 1 },
      "not json",
      "[]",
      JSON.stringify({ unknown: 7 }),
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, strings: ["raw", 3] }),
      JSON.stringify({ ...valid, rows: [0] }),
      JSON.stringify({ ...valid, rows: [0, 9] }),
      JSON.stringify({ ...valid, rows: [0, 1.5] }),
      JSON.stringify({ ...valid, rows: [0, -1] }),
      JSON.stringify({ ...valid, columns: [[]] }),
      JSON.stringify({ ...valid, columns: [[2, 0]] }),
      JSON.stringify({ ...valid, columns: {} }),
      // A column listed twice would read as its last entry, which could narrow it.
      JSON.stringify({ ...valid, columns: [[1, 0, 1], [1]] }),
    ]

    for (const stored of malformed) {
      expect(decodeLineage("analytics", stored)).toEqual(unreadable)
    }
  })
})
