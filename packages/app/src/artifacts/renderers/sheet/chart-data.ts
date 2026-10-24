import { parseSheetNumber, type WorkbookChart } from "@sixb/core/artifacts"
import { lockedColumns, type SheetColumn, type SheetModel } from "./model"

export interface ChartSeries {
  /** The data key, safe for the chart library whatever the column is named. */
  readonly key: string
  readonly label: string
  /** One of the theme's chart colors. */
  readonly color: string
  readonly column: SheetColumn
  /** A column a bar chart draws as a line over its bars. */
  readonly line: boolean
  /** It reads on the right axis: a line whose values are of another kind than the bars'. */
  readonly right: boolean
}

export interface ChartData {
  /**
   * A row per point: `x` is the category or date, or a scatter's number, and each series' key its
   * value. A scatter's point has its row's `name` too, from the sheet's first column.
   */
  readonly rows: readonly Readonly<Record<string, string | number | null>>[]
  readonly series: readonly ChartSeries[]
  readonly x: SheetColumn
}

/**
 * The most points a chart draws. A longer sheet is sampled evenly, its first and last rows kept:
 * more points than this are more than a chart's width shows apart, and each one costs the chart
 * library on every draw. A pie's slices are capped when it is published.
 */
export const MAX_CHART_POINTS = 500

/**
 * Whether a chart would draw from values the reader may not see: a locked cell in its x column or
 * a column it plots. Drawn without them it would pass a part for the whole, so it shows locked
 * instead. A chart that counts rows reads no value but its x.
 */
export function chartReadsLocked(chart: WorkbookChart, model: SheetModel): boolean {
  return chartLockedColumns(chart, model).length > 0
}

/** The columns a chart reads that hold a value the reader may not see, in the sheet's order. */
export function chartLockedColumns(chart: WorkbookChart, model: SheetModel): string[] {
  const read = new Set([chart.x, ...chart.y, ...chart.line])
  return lockedColumns(model).filter((name) => read.has(name))
}

/** The series a chart that counts rows plots: a whole number for each x value. */
function countColumn(label: string): SheetColumn {
  return { name: label, format: { type: "number" }, numeric: true, decimals: 0, width: 0 }
}

/**
 * A chart's rows and series from its sheet: the x column's values in sheet order, a series per y
 * column and then per line column in the theme's chart colors, and an empty or unreadable cell as
 * a gap, not a zero. A chart that aggregates has a row for each x value, in the order the values
 * first appear: the sum or average of each series' numbers there, or the count of rows.
 */
export function chartData(
  chart: WorkbookChart,
  model: SheetModel,
  countLabel = "Count"
): ChartData | null {
  const xIndex = model.columns.findIndex((column) => column.name === chart.x)
  const x = model.columns[xIndex]
  const named = [
    ...chart.y.map((name) => ({ name, line: false })),
    ...chart.line.map((name) => ({ name, line: true })),
  ]
  const columns = named.flatMap((entry) => {
    const column = model.columns.find((candidate) => candidate.name === entry.name)
    return column ? [{ column, line: entry.line }] : []
  })
  if (chart.aggregate === "count") columns.push({ column: countColumn(countLabel), line: false })
  const barType = columns.find((entry) => !entry.line)?.column.format.type
  // Lines over bars take the theme's strongest colors and the bars its lighter ones, so a line
  // reads where it crosses a bar.
  const lines = columns.filter((entry) => entry.line).length
  let bar = 0
  let line = 0
  const series = columns.map(({ column, line: isLine }, index): ChartSeries => {
    const tone = lines === 0 ? index : isLine ? line++ : 3 + bar++
    return {
      key: `s${index}`,
      label: column.name,
      color: `var(--chart-${(tone % 5) + 1})`,
      column,
      line: isLine,
      right: isLine && column.format.type !== barType,
    }
  })
  if (!x || series.length === 0) return null
  const indexes = series.map((entry) => model.columns.indexOf(entry.column))
  const number = (row: readonly string[], position: number) =>
    parseSheetNumber(row[indexes[position] ?? -1] ?? "") ?? null

  if (chart.aggregate) {
    const groups = new Map<string, (readonly string[])[]>()
    for (const row of model.rows) {
      const key = (row[xIndex] ?? "").trim()
      if (!key) continue
      const group = groups.get(key)
      if (group) group.push(row)
      else groups.set(key, [row])
    }
    const rows = Array.from(groups, ([key, rows]) => {
      const values: Record<string, string | number | null> = { x: key }
      series.forEach((entry, position) => {
        if (chart.aggregate === "count") {
          values[entry.key] = rows.length
          return
        }
        const numbers = rows
          .map((row) => number(row, position))
          .filter((value): value is number => value !== null)
        const sum = numbers.reduce((total, value) => total + value, 0)
        values[entry.key] =
          numbers.length === 0 ? null : chart.aggregate === "average" ? sum / numbers.length : sum
      })
      return values
    })
    return { x, series, rows: chart.type === "pie" ? rows : sampled(rows, MAX_CHART_POINTS) }
  }

  if (chart.type === "scatter") {
    // A point is named by the row's first column, as a scatter's points are read.
    const nameIndex = xIndex === 0 ? -1 : 0
    const rows = model.rows.flatMap((row) => {
      const at = parseSheetNumber(row[xIndex] ?? "")
      if (at === undefined) return []
      const values: Record<string, string | number | null> = {
        x: at,
        name: nameIndex < 0 ? "" : (row[nameIndex] ?? ""),
      }
      series.forEach((entry, position) => {
        values[entry.key] = number(row, position)
      })
      return [values]
    })
    return { x, series, rows: sampled(rows, MAX_CHART_POINTS) }
  }

  const rows = chart.type === "pie" ? model.rows : sampled(model.rows, MAX_CHART_POINTS)
  return {
    x,
    series,
    rows: rows.map((row) => {
      const values: Record<string, string | number | null> = { x: row[xIndex] ?? "" }
      series.forEach((entry, position) => {
        values[entry.key] = number(row, position)
      })
      return values
    }),
  }
}

/**
 * The value a chart labels at its last point: the first series', or a stack's total, since the
 * label sits on top of the stack. Null when that point has no value.
 */
export function latestValue(data: ChartData, stacked: boolean): number | null {
  const row = data.rows.at(-1)
  const bars = data.series.filter((series) => !series.line)
  const values = (stacked ? bars : bars.slice(0, 1))
    .map((series) => row?.[series.key])
    .filter((value): value is number => typeof value === "number")
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0)
}

/** At most `count` items, evenly spaced, the first and the last among them. */
function sampled<Item>(items: readonly Item[], count: number): readonly Item[] {
  if (items.length <= count) return items
  const step = (items.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => items[Math.round(index * step)] as Item)
}
