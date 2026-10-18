import { describe, expect, test } from "bun:test"
import { parseCsv, parseWorkbook, type Workbook } from "@sixb/core/artifacts"
import { chartData, MAX_CHART_POINTS } from "../src/artifacts/renderers/sheet/chart-data"
import { cellFormatter, compactFormatter } from "../src/artifacts/renderers/sheet/format"
import { fileSheetModel, sheetModel } from "../src/artifacts/renderers/sheet/model"
import {
  cellRange,
  columnLetter,
  moveFocus,
  rangeLabel,
  rangeStats,
  rangeTsv,
  sortedOrder,
} from "../src/artifacts/renderers/sheet/selection"
import {
  prefixOffsets,
  visibleRowSpan,
  visibleSpan,
} from "../src/artifacts/renderers/sheet/virtual"

const workbook = (() => {
  const parsed = parseWorkbook(
    JSON.stringify({
      sheets: [
        {
          name: "Summary",
          columns: {
            Revenue: "currency",
            Margin: "percent",
            Units: { type: "number", decimals: 0 },
            Closed: "date",
            Site: "link",
          },
        },
      ],
      charts: [
        { name: "revenue", type: "bar", sheet: "Summary", x: "Quarter", y: ["Revenue", "Units"] },
      ],
    })
  )
  if (!("workbook" in parsed)) throw new Error(parsed.error)
  return parsed.workbook as Workbook
})()

const table = parseCsv(
  [
    "Quarter,Revenue,Margin,Units,Closed,Site",
    "Q4 2025,4120000,0.269,1200,2025-12-31,https://northline.example/q4/",
    "Q1 2026,4380000.5,0.281,,2026-03-31,",
    "Q2 2026,-15000,0.3,980,2026-06-30T17:30:00Z,",
    "Q3 2026,5560000,0.351,1410.6,2026-09-30,",
  ].join("\n")
)
const sheet = workbook.sheets[0]
if (!sheet) throw new Error("Expected a sheet.")
const model = sheetModel(sheet, table)

describe("a sheet's columns", () => {
  test("carry their formats, the decimals their values need, and a width that fits", () => {
    expect(
      model.columns.map((column) => [column.name, column.format.type, column.decimals])
    ).toEqual([
      ["Quarter", "text", 0],
      ["Revenue", "currency", 1],
      ["Margin", "percent", 1],
      ["Units", "number", 0],
      ["Closed", "date", 0],
      ["Site", "link", 0],
    ])
    for (const column of model.columns) {
      expect(column.width).toBeGreaterThanOrEqual(72)
      expect(column.width).toBeLessThanOrEqual(320)
    }
  })

  test("of a plain CSV read numbers where every value is one, and name extra columns", () => {
    const file = fileSheetModel(
      "regions.csv",
      parseCsv("region,visits\nNorth,1284,extra\nSouth,962\n")
    )
    expect(file.columns.map((column) => [column.name, column.format.type])).toEqual([
      ["region", "text"],
      ["visits", "number"],
      ["", "text"],
    ])
    expect(file.rows).toEqual([
      ["North", "1284", "extra"],
      ["South", "962", ""],
    ])
  })

  test("of a long CSV are measured without spreading its rows into one call", () => {
    // Reproduce with `Math.max(header, ...rows.map(...))` in fileSheetModel: a call takes about
    // 125,000 arguments in V8 and 500,000 in Bun's JavaScriptCore, so this goes past both. A 5 MB
    // file of one short column holds over two million rows.
    const rows = Array.from({ length: 1_000_000 }, (_, index) =>
      index === 999_999 ? ["9", "wide"] : ["1"]
    )
    const file = fileSheetModel("long.csv", { header: ["n"], rows })
    expect(file.columns.map((column) => column.name)).toEqual(["n", ""])
    expect(file.rows.length).toBe(1_000_000)
  })
})

describe("cell formatting", () => {
  const format = (name: string, value: string, locale = "en-US") => {
    const column = model.columns.find((candidate) => candidate.name === name)
    if (!column) throw new Error(`No column ${name}`)
    return cellFormatter(column, locale)(value)
  }

  test("follows the column's type and the reader's locale", () => {
    expect(format("Revenue", "4120000")).toEqual({ text: "$4,120,000.0" })
    expect(format("Revenue", "-15000")).toEqual({ text: "-$15,000.0", negative: true })
    // French groups with narrow no-break spaces and keeps a space before the currency.
    expect(format("Revenue", "4120000", "fr-FR").text.replace(/\s/g, " ")).toBe("4 120 000,0 $US")
    expect(format("Margin", "0.351")).toEqual({ text: "35.1%" })
    expect(format("Units", "1410.6")).toEqual({ text: "1,411" })
    expect(format("Closed", "2025-12-31")).toEqual({ text: "Dec 31, 2025" })
    expect(format("Closed", "2025-12-31", "fr-FR")).toEqual({ text: "31 déc. 2025" })
    expect(format("Site", "https://northline.example/q4/")).toEqual({
      text: "northline.example/q4",
      href: "https://northline.example/q4/",
    })
    expect(format("Quarter", "Q4 2025")).toEqual({ text: "Q4 2025" })
  })

  test("shows a value that is not its type as written", () => {
    expect(format("Revenue", "n/a")).toEqual({ text: "n/a" })
    expect(format("Closed", "soon")).toEqual({ text: "soon" })
  })

  test("is compact on chart axes", () => {
    const revenue = model.columns[1]
    const margin = model.columns[2]
    if (!revenue || !margin) throw new Error("Expected columns.")
    expect(compactFormatter(revenue, "en-US")(4_120_000)).toBe("$4.1M")
    expect(compactFormatter(margin, "en-US")(0.351)).toBe("35.1%")
  })
})

describe("selection", () => {
  const order = model.rows.map((_, index) => index)

  test("is named in A1 notation, the header row being row 1", () => {
    expect(rangeLabel(cellRange({ row: 1, column: 1 }, { row: 1, column: 1 }))).toBe("B2")
    expect(rangeLabel(cellRange({ row: 4, column: 3 }, { row: 1, column: 1 }))).toBe("B2:D5")
    expect([0, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"])
  })

  test("sums and averages the numbers of numeric columns, and counts every value", () => {
    // B1:C5: the header labels are not values; Revenue and Margin hold 8 numbers.
    const stats = rangeStats(cellRange({ row: 0, column: 1 }, { row: 4, column: 2 }), model, order)
    expect(stats.count).toBe(8)
    expect(stats.numericCount).toBe(8)
    expect(stats.sum).toBeCloseTo(
      4120000 + 4380000.5 - 15000 + 5560000 + 0.269 + 0.281 + 0.3 + 0.351
    )
    // A column of text counts, but has nothing to sum.
    expect(
      rangeStats(cellRange({ row: 1, column: 0 }, { row: 4, column: 0 }), model, order)
    ).toEqual({
      count: 4,
      numericCount: 0,
      sum: 0,
    })
  })

  test("copies as tab-separated values, header included when selected", () => {
    expect(rangeTsv(cellRange({ row: 0, column: 0 }, { row: 2, column: 1 }), model, order)).toBe(
      "Quarter\tRevenue\nQ4 2025\t4120000\nQ1 2026\t4380000.5"
    )
  })

  test("moves with the arrows, and to the edge with Cmd held", () => {
    const bounds = { rows: 5, columns: 6 }
    expect(moveFocus({ row: 2, column: 2 }, "ArrowDown", bounds)).toEqual({ row: 3, column: 2 })
    expect(moveFocus({ row: 4, column: 2 }, "ArrowDown", bounds)).toEqual({ row: 4, column: 2 })
    expect(moveFocus({ row: 2, column: 2 }, "ArrowRight", bounds, true)).toEqual({
      row: 2,
      column: 5,
    })
    expect(moveFocus({ row: 2, column: 2 }, "Home", bounds, true)).toEqual({ row: 0, column: 0 })
  })

  test("sorts numbers as numbers and leaves empty cells last", () => {
    const units = model.columns.findIndex((column) => column.name === "Units")
    expect(sortedOrder(model, { column: units, direction: "ascending" }, "en")).toEqual([
      2, 0, 3, 1,
    ])
    expect(sortedOrder(model, { column: units, direction: "descending" }, "en")).toEqual([
      3, 0, 2, 1,
    ])
    expect(sortedOrder(model, null, "en")).toEqual([0, 1, 2, 3])
  })
})

describe("the visible window", () => {
  test("covers the columns in view, widened by the overscan", () => {
    const offsets = prefixOffsets([100, 50, 200, 80])
    expect(offsets).toEqual([0, 100, 150, 350, 430])
    expect(visibleSpan(offsets, 0, 120)).toEqual({ first: 0, last: 1 })
    expect(visibleSpan(offsets, 160, 300)).toEqual({ first: 2, last: 2 })
    expect(visibleSpan(offsets, 160, 300, 1)).toEqual({ first: 1, last: 3 })
    expect(visibleSpan(offsets, 400, 2000)).toEqual({ first: 3, last: 3 })
  })

  test("covers the rows in view without an offset per row", () => {
    expect(visibleRowSpan(32, 100_000, 3200, 3200 + 640)).toEqual({ first: 100, last: 119 })
    expect(visibleRowSpan(32, 10, 0, 10_000, 5)).toEqual({ first: 0, last: 9 })
    expect(visibleRowSpan(32, 0, 0, 640)).toEqual({ first: 0, last: -1 })
  })
})

describe("a chart's data", () => {
  test("is a row per data row, a series per column in the theme's colors, and gaps not zeros", () => {
    const chart = workbook.charts[0]
    if (!chart) throw new Error("Expected a chart.")
    const data = chartData(chart, model)
    expect(data?.series.map((series) => [series.key, series.label, series.color])).toEqual([
      ["s0", "Revenue", "var(--chart-1)"],
      ["s1", "Units", "var(--chart-2)"],
    ])
    expect(data?.rows[1]).toEqual({ x: "Q1 2026", s0: 4380000.5, s1: null })
    expect(data?.x.name).toBe("Quarter")
  })

  test("of a long sheet is sampled evenly to what a chart can draw, its ends kept", () => {
    // Reproduce by mapping every row in chartData: a chart of 100,000 rows draws 100,000 points
    // on every render.
    const chart = workbook.charts[0]
    if (!chart) throw new Error("Expected a chart.")
    const long = sheetModel(
      sheet,
      parseCsv(
        [
          "Quarter,Revenue,Margin,Units,Closed,Site",
          ...Array.from({ length: 100_000 }, (_, index) => `Day ${index + 1},${index},0.3,1,,`),
        ].join("\n")
      )
    )
    const data = chartData(chart, long)
    expect(data?.rows.length).toBe(MAX_CHART_POINTS)
    expect(data?.rows[0]?.x).toBe("Day 1")
    expect(data?.rows.at(-1)?.x).toBe("Day 100000")
    // A pie keeps every row: publishing caps its slices.
    expect(chartData({ ...chart, type: "pie" }, long)?.rows.length).toBe(100_000)
  })
})
