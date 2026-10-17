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
  /** One row per data row: `x` is the category or date, and each series' key its value. */
  readonly rows: readonly Readonly<Record<string, string | number | null>>[]
  readonly series: readonly ChartSeries[]
  readonly x: SheetColumn
}

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
  return {
    x,
    series,
    rows: model.rows.map((row) => {
      const values: Record<string, string | number | null> = { x: row[xIndex] ?? "" }
      series.forEach((entry, position) => {
        values[entry.key] = parseSheetNumber(row[indexes[position] ?? -1] ?? "") ?? null
      })
      return values
    }),
  }
}
