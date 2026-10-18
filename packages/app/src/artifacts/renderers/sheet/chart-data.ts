import { parseSheetNumber, type WorkbookChart } from "@sixb/core/artifacts"
import type { SheetColumn, SheetModel } from "./model"

export interface ChartSeries {
  /** The data key, safe for the chart library whatever the column is named. */
  readonly key: string
  readonly label: string
  /** One of the theme's chart colors. */
  readonly color: string
  readonly column: SheetColumn
}

export interface ChartData {
  /** A row per point: `x` is the category or date, and each series' key its value. */
  readonly rows: readonly Readonly<Record<string, string | number | null>>[]
  readonly series: readonly ChartSeries[]
  readonly x: SheetColumn
}

/**
 * The most points a line, area, or bar chart draws. A longer sheet is sampled evenly, its first
 * and last rows kept: more points than this are more than a chart's width shows apart, and each
 * one costs the chart library on every draw. A pie's slices are capped when it is published.
 */
export const MAX_CHART_POINTS = 500

/**
 * A chart's rows and series from its sheet: the x column's values in sheet order, a series per y
 * column in the theme's chart colors, and an empty or unreadable cell as a gap, not a zero.
 */
export function chartData(chart: WorkbookChart, model: SheetModel): ChartData | null {
  const xIndex = model.columns.findIndex((column) => column.name === chart.x)
  const x = model.columns[xIndex]
  const series = chart.y.flatMap((name, index): ChartSeries[] => {
    const column = model.columns.find((candidate) => candidate.name === name)
    return column
      ? [{ key: `s${index}`, label: name, color: `var(--chart-${(index % 5) + 1})`, column }]
      : []
  })
  if (!x || series.length === 0) return null
  const indexes = series.map((entry) => model.columns.indexOf(entry.column))
  const rows = chart.type === "pie" ? model.rows : sampled(model.rows, MAX_CHART_POINTS)
  return {
    x,
    series,
    rows: rows.map((row) => {
      const values: Record<string, string | number | null> = { x: row[xIndex] ?? "" }
      series.forEach((entry, position) => {
        values[entry.key] = parseSheetNumber(row[indexes[position] ?? -1] ?? "") ?? null
      })
      return values
    }),
  }
}

/** At most `count` items, evenly spaced, the first and the last among them. */
function sampled<Item>(items: readonly Item[], count: number): readonly Item[] {
  if (items.length <= count) return items
  const step = (items.length - 1) / (count - 1)
  return Array.from({ length: count }, (_, index) => items[Math.round(index * step)] as Item)
}
