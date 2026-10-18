import { describe, expect, test } from "bun:test"
import { parseCsv, parseWorkbook, type Workbook } from "@sixb/core/artifacts"
import {
  chartData,
  latestValue,
  MAX_CHART_POINTS,
} from "../src/artifacts/renderers/sheet/chart-data"
import {
  type ColumnFilter,
  distinctValues,
  filteredOrder,
  readFilterInput,
} from "../src/artifacts/renderers/sheet/filter"
import { findMatches, MAX_FIND_MATCHES } from "../src/artifacts/renderers/sheet/find"
import { fitWidth } from "../src/artifacts/renderers/sheet/fit"
import { cellFormatter, compactFormatter } from "../src/artifacts/renderers/sheet/format"
import { fileSheetModel, sheetModel } from "../src/artifacts/renderers/sheet/model"
import {
  cellRange,
  columnLetter,
  moveFocus,
  rangeHtml,
  rangeLabel,
  rangeStats,
  rangeTsv,
  sortedOrder,
} from "../src/artifacts/renderers/sheet/selection"
import { columnTotals } from "../src/artifacts/renderers/sheet/totals"
import {
  hideColumn,
  INITIAL_SHEET_VIEW,
  setAutoFilter,
  setColumnFilter,
  visibleColumn,
} from "../src/artifacts/renderers/sheet/view"
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

  test("follows the column's type and the reader's locale, and shows any other value as written", () => {
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

  test("sums the numbers of a text column too, as a spreadsheet sums any number", () => {
    const mixed = fileSheetModel("Mixed", parseCsv("Value,Note\n5100 USD,a\n42,b\n8,c\n"))
    // fileSheetModel types a column of not only numbers as text.
    expect(mixed.columns[0]?.numeric).toBe(false)
    const stats = rangeStats(
      cellRange({ row: 1, column: 0 }, { row: 3, column: 0 }),
      mixed,
      [0, 1, 2]
    )
    expect(stats).toMatchObject({ count: 3, numericCount: 2, sum: 50 })
  })

  test("finds the smallest and largest number in what is selected", () => {
    const stats = rangeStats(cellRange({ row: 1, column: 1 }, { row: 4, column: 1 }), model, order)
    expect(stats).toMatchObject({ min: -15000, max: 5560000 })
  })

  test("copies as a table of the values as shown, escaped, with links kept", () => {
    const formatters = model.columns.map((column) => cellFormatter(column, "en-US"))
    expect(
      rangeHtml(cellRange({ row: 0, column: 4 }, { row: 1, column: 5 }), model, order, formatters)
    ).toBe(
      "<table><tr><th>Closed</th><th>Site</th></tr>" +
        '<tr><td>Dec 31, 2025</td><td><a href="https://northline.example/q4/">northline.example/q4</a></td></tr></table>'
    )
    const tagged = sheetModel(sheet, parseCsv('Quarter\n"<b>Q1 & ""Q2""</b>"\n'))
    expect(
      rangeHtml(
        cellRange({ row: 1, column: 0 }, { row: 1, column: 0 }),
        tagged,
        [0],
        tagged.columns.map((column) => cellFormatter(column, "en-US"))
      )
    ).toBe("<table><tr><td>&lt;b&gt;Q1 &amp; &quot;Q2&quot;&lt;/b&gt;</td></tr></table>")
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

describe("finding in a sheet", () => {
  const formatters = model.columns.map((column) => cellFormatter(column, "en-US"))
  const order = model.rows.map((_, index) => index)
  const found = (query: string, rows = order) =>
    findMatches(model, rows, formatters, query).points.map((point) =>
      rangeLabel(cellRange(point, point))
    )

  test("matches a value as shown or as stored, in reading order, never the header", () => {
    // "4,380" is how the grid shows 4380000.5; "4380" is how it is stored.
    expect(found("4,380")).toEqual(["B3"])
    expect(found("4380")).toEqual(["B3"])
    // Row 2's site, northline.example/q4, holds a "q" too.
    expect(found("q")).toEqual(["A2", "F2", "A3", "A4", "A5"])
    expect(found("2026")).toEqual(["A3", "A4", "E4", "A5", "E5", "E3"].sort(byReading))
    expect(found("Revenue")).toEqual([])
    expect(found("   ")).toEqual([])
  })

  test("ignores case and accents", () => {
    const cafe = fileSheetModel("Places", parseCsv("Name\nCafé Nord\nCAFE SUD\n"))
    const column = cafe.columns[0]
    if (!column) throw new Error("Expected a column.")
    const points = findMatches(cafe, [0, 1], [cellFormatter(column, "en-US")], "cafe").points
    expect(points).toEqual([
      { row: 1, column: 0 },
      { row: 2, column: 0 },
    ])
  })

  test("passes over hidden columns", () => {
    const points = findMatches(model, order, formatters, "q4", new Set([5])).points
    expect(points).toEqual([{ row: 1, column: 0 }])
  })

  test("follows the sheet's current order", () => {
    expect(found("q4", [3, 2, 1, 0])).toEqual(["A5", "F5"])
  })

  test("stops at its limit, and says so", () => {
    const many = fileSheetModel(
      "Many",
      parseCsv(["A,B", ...Array.from({ length: 6_000 }, () => "x,x")].join("\n"))
    )
    const result = findMatches(
      many,
      many.rows.map((_, index) => index),
      many.columns.map((column) => cellFormatter(column, "en-US")),
      "x"
    )
    expect(result.points).toHaveLength(MAX_FIND_MATCHES)
    expect(result.capped).toBe(true)
  })
})

/** A1 names in reading order: along each row, then down. */
function byReading(left: string, right: string): number {
  const row = (name: string) => Number(name.slice(1))
  return row(left) - row(right) || left.localeCompare(right)
}

describe("fitting a column", () => {
  const tenPerCharacter = (text: string) => text.length * 10

  test("takes the wider of its header, with its glyph and sort control, and its widest value", () => {
    const quarter = model.columns[0]
    const revenue = model.columns[1]
    if (!quarter || !revenue) throw new Error("Expected columns.")
    // "Quarter": 70 + 54 for the header; "Q4 2025": 70 + 24 for the cell.
    expect(fitWidth(quarter, 0, model.rows, cellFormatter(quarter, "en-US"), tenPerCharacter)).toBe(
      124
    )
    // "Revenue": 70 + 54 + 18 for its currency glyph; "$4,380,000.5": 120 + 24.
    expect(fitWidth(revenue, 1, model.rows, cellFormatter(revenue, "en-US"), tenPerCharacter)).toBe(
      144
    )
  })

  test("reads at most 2,000 rows of a long sheet", () => {
    const long = fileSheetModel(
      "Long",
      parseCsv(["Name", ...Array.from({ length: 10_000 }, (_, index) => `row ${index}`)].join("\n"))
    )
    const column = long.columns[0]
    if (!column) throw new Error("Expected a column.")
    let measured = 0
    fitWidth(column, 0, long.rows, cellFormatter(column, "en-US"), (text) => {
      measured += 1
      return text.length
    })
    expect(measured).toBeLessThanOrEqual(2_001)
  })
})

describe("filtering a sheet", () => {
  const order = model.rows.map((_, index) => index)
  const quarters = (filters: Record<number, ColumnFilter>, locale = "en-US") =>
    filteredOrder(model, order, filters, locale).map((index) => model.rows[index]?.[0])

  test("hides the values a values filter names, empty cells among them", () => {
    expect(quarters({ 0: { kind: "values", excluded: ["Q1 2026", "Q3 2026"] } })).toEqual([
      "Q4 2025",
      "Q2 2026",
    ])
    // Units is empty in Q1 2026.
    expect(quarters({ 3: { kind: "values", excluded: [""] } })).toEqual([
      "Q4 2025",
      "Q2 2026",
      "Q3 2026",
    ])
  })

  test("compares numbers and percents as the reader types them, in their locale", () => {
    const revenue = (op: "gt" | "lt", value: string) => ({
      1: { kind: "condition" as const, op, value },
    })
    expect(quarters(revenue("gt", "$4,200,000"))).toEqual(["Q1 2026", "Q3 2026"])
    expect(quarters(revenue("lt", "0"))).toEqual(["Q2 2026"])
    expect(quarters(revenue("gt", "4 200 000,25"), "fr-FR")).toEqual(["Q1 2026", "Q3 2026"])
    // Margin stores 0.281; the reader types 28.1 for 28.1%.
    expect(quarters({ 2: { kind: "condition", op: "eq", value: "28.1" } })).toEqual(["Q1 2026"])
    expect(quarters({ 2: { kind: "condition", op: "between", value: "30", to: "27" } })).toEqual([
      "Q1 2026",
      "Q2 2026",
    ])
  })

  test("compares dates by their day, a date-time's included", () => {
    expect(
      quarters({ 4: { kind: "condition", op: "between", value: "2026-03-31", to: "2026-06-30" } })
    ).toEqual(["Q1 2026", "Q2 2026"])
    expect(quarters({ 4: { kind: "condition", op: "eq", value: "2026-06-30" } })).toEqual([
      "Q2 2026",
    ])
  })

  test("counts an empty cell as not equal, and as nothing else", () => {
    expect(quarters({ 3: { kind: "condition", op: "ne", value: "1200" } })).toEqual([
      "Q1 2026",
      "Q2 2026",
      "Q3 2026",
    ])
    expect(quarters({ 3: { kind: "condition", op: "lt", value: "99999" } })).toEqual([
      "Q4 2025",
      "Q2 2026",
      "Q3 2026",
    ])
    expect(quarters({ 3: { kind: "condition", op: "empty" } })).toEqual(["Q1 2026"])
  })

  test("keeps rows only every filter keeps, and matches none for a value of the wrong type", () => {
    expect(
      quarters({
        1: { kind: "condition", op: "gt", value: "0" },
        2: { kind: "condition", op: "lt", value: "30" },
      })
    ).toEqual(["Q4 2025", "Q1 2026"])
    expect(quarters({ 1: { kind: "condition", op: "gt", value: "lots" } })).toEqual([])
  })

  test("reads typed numbers with the locale's separators", () => {
    const revenue = model.columns[1]
    if (!revenue) throw new Error("Expected a column.")
    expect(readFilterInput(revenue, "en-US")("$4,120,000.5")).toBe(4120000.5)
    expect(readFilterInput(revenue, "de-DE")("4.120.000,5 €")).toBe(4120000.5)
    expect(readFilterInput(revenue, "en-US")("")).toBeUndefined()
  })

  test("lists a column's values, most frequent first, and how many it left out", () => {
    const repeated = fileSheetModel("Regions", parseCsv('Region\nNorth\nSouth\nNorth\n""\nEast\n'))
    expect(distinctValues(repeated, 0)).toEqual({
      values: [
        { value: "North", count: 2 },
        { value: "", count: 1 },
        { value: "East", count: 1 },
        { value: "South", count: 1 },
      ],
      more: 0,
    })
    expect(distinctValues(repeated, 0, 2).more).toBe(2)
  })

  test("takes a filter off the view when it would keep every row", () => {
    const filtered = setColumnFilter(INITIAL_SHEET_VIEW, 1, {
      kind: "condition",
      op: "gt",
      value: "5",
    })
    expect(Object.keys(filtered.filters)).toEqual(["1"])
    expect(
      setColumnFilter(filtered, 1, { kind: "condition", op: "gt", value: " " }).filters
    ).toEqual({})
    expect(setColumnFilter(filtered, 1, { kind: "values", excluded: [] }).filters).toEqual({})
    expect(setColumnFilter(filtered, 1, null).filters).toEqual({})
  })
})

describe("a reader's view of a sheet", () => {
  test("takes every filter off when filter mode is turned off", () => {
    const on = setAutoFilter(INITIAL_SHEET_VIEW, true)
    const filtered = setColumnFilter(on, 0, { kind: "values", excluded: ["Q1 2026"] })
    expect(filtered).toMatchObject({ autoFilter: true, filters: { 0: {} } })
    expect(setAutoFilter(filtered, false)).toMatchObject({ autoFilter: false, filters: {} })
  })

  test("keeps its hidden columns in order, once each", () => {
    const view = hideColumn(hideColumn(hideColumn(INITIAL_SHEET_VIEW, 4), 1), 4)
    expect(view.hidden).toEqual([1, 4])
  })

  test("moves past hidden columns the way a move went, turning back at the edge", () => {
    const hidden = new Set([0, 2, 3])
    // Right from B lands past C and D on E; left from E, back on B.
    expect(visibleColumn(2, 1, 6, hidden)).toBe(4)
    expect(visibleColumn(3, 4, 6, hidden)).toBe(1)
    // Home, to a hidden A: turn back to the first shown.
    expect(visibleColumn(0, 4, 6, hidden)).toBe(1)
    expect(visibleColumn(5, 1, 6, hidden)).toBe(5)
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
    // Reproduce by mapping every row in chartData: a chart of 10,000 rows draws 10,000 points on
    // every render.
    const chart = workbook.charts[0]
    if (!chart) throw new Error("Expected a chart.")
    const long = sheetModel(
      sheet,
      parseCsv(
        [
          "Quarter,Revenue,Margin,Units,Closed,Site",
          ...Array.from({ length: 10_000 }, (_, index) => `Day ${index + 1},${index},0.3,1,,`),
        ].join("\n")
      )
    )
    const data = chartData(chart, long)
    expect(data?.rows.length).toBe(MAX_CHART_POINTS)
    expect(data?.rows[0]?.x).toBe("Day 1")
    expect(data?.rows.at(-1)?.x).toBe("Day 10000")
    // A pie keeps every row: publishing caps its slices.
    expect(chartData({ ...chart, type: "pie" }, long)?.rows.length).toBe(10_000)
  })

  test("labels its last point with the first series, or with a stack's total", () => {
    // The label of a stacked chart sits on top of the stack. Reproduce by labelling the top
    // series' own value: Q3's stack of 5,560,000 and 1,410.6 reads as 1,410.6.
    const chart = workbook.charts[0]
    if (!chart) throw new Error("Expected a chart.")
    const data = chartData(chart, model)
    if (!data) throw new Error("Expected chart data.")
    expect(latestValue(data, false)).toBe(5_560_000)
    expect(latestValue(data, true)).toBe(5_561_410.6)
    // A gap in the last row is left out of the total, and a row of gaps has no label.
    expect(latestValue({ ...data, rows: [{ x: "Q4 2026", s0: null, s1: 12 }] }, true)).toBe(12)
    expect(latestValue({ ...data, rows: [{ x: "Q4 2026", s0: null, s1: null }] }, true)).toBeNull()
  })
})

describe("totals and number styles", () => {
  const regions = (() => {
    const parsed = parseWorkbook(
      JSON.stringify({
        sheets: [
          {
            name: "Regions",
            columns: {
              Visits: { type: "number", compact: true },
              Cost: { type: "currency", compact: true },
              Change: { type: "percent", decimals: 1, signed: true },
            },
            totals: { Visits: "sum", Cost: "max", Change: "average", Lead: "count" },
          },
        ],
      })
    )
    if (!("workbook" in parsed)) throw new Error(parsed.error)
    return sheetModel(
      parsed.workbook.sheets[0] as Workbook["sheets"][number],
      parseCsv(
        [
          "Region,Visits,Cost,Change,Lead",
          "North,1204330,182400,0.032,Ana",
          "South,962000,141950,-0.014,",
          "Coastal,448000,,0,Lee",
        ].join("\n")
      )
    )
  })()
  const format = (name: string, value: string, locale: string) => {
    const column = regions.columns.find((candidate) => candidate.name === name)
    if (!column) throw new Error(`No column ${name}`)
    return cellFormatter(column, locale)(value).text.replace(/\s/g, " ")
  }

  test("read compact and signed in the reader's locale", () => {
    expect(format("Visits", "1204330", "en-US")).toBe("1.2M")
    expect(format("Visits", "1204330", "de-DE")).toBe("1,2 Mio.")
    expect(format("Cost", "182400", "en-US")).toBe("$182.4K")
    expect(format("Cost", "1992500", "en-US")).toBe("$2.0M")
    expect(format("Change", "0.032", "en-US")).toBe("+3.2%")
    expect(format("Change", "-0.014", "en-US")).toBe("-1.4%")
    expect(format("Change", "0", "en-US")).toBe("0.0%")
    expect(format("Change", "0.032", "de-DE")).toBe("+3,2 %")
  })

  test("total what the filters leave, and count values in any column", () => {
    const all = regions.rows.map((_, index) => index)
    expect(regions.totals).toBe(true)
    expect(Object.fromEntries(columnTotals(regions, all))).toEqual({
      1: { total: "sum", value: 2_614_330 },
      2: { total: "max", value: 182_400 },
      3: { total: "average", value: (0.032 - 0.014 + 0) / 3 },
      4: { total: "count", value: 2 },
    })
    // Filtering North out takes it out of every total; sorting changes none.
    // Reproduce by totaling every row of the model: the sum stays 2,614,330.
    const shown = filteredOrder(
      regions,
      all,
      { 0: { kind: "values", excluded: ["North"] } },
      "en-US"
    )
    expect(columnTotals(regions, shown).get(1)).toEqual({ total: "sum", value: 1_410_000 })
    expect(columnTotals(regions, [...shown].reverse()).get(1)?.value).toBe(1_410_000)
    // A column with no numbers left has no total but a count.
    expect(columnTotals(regions, []).get(1)?.value).toBeUndefined()
    expect(columnTotals(regions, []).get(4)?.value).toBe(0)
  })
})
