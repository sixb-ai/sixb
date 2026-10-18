import { ARTIFACT_LIMITS } from "./limits"

/**
 * A sheet artifact is `workbook.json` and one CSV per sheet under `sheets/`. The CSV holds the
 * values; the workbook holds what CSV can't: sheet order, column types and formats, frozen rows
 * and columns, widths, descriptions and totals, and charts drawn from the sheets.
 */
export const WORKBOOK_FILE = "workbook.json"

export const SHEET_COLUMN_TYPES = [
  "text",
  "number",
  "currency",
  "percent",
  "date",
  "link",
  "image",
  "boolean",
  "tag",
] as const
export type SheetColumnType = (typeof SHEET_COLUMN_TYPES)[number]

/** Column types whose cells are numbers, so a chart can plot them and a range can sum them. */
export const NUMERIC_COLUMN_TYPES: readonly SheetColumnType[] = ["number", "currency", "percent"]

/**
 * The colors a tag's values take: the theme's meanings, or one of its chart colors. A value not
 * named is neutral.
 */
export const SHEET_TONES = [
  "neutral",
  "positive",
  "warning",
  "negative",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const
export type SheetTone = (typeof SHEET_TONES)[number]

/**
 * How a numeric column's cells are shaded by value, across the column: a bar in the cell, a
 * shade from light to dark, or two colors either side of zero.
 */
export const SHEET_HIGHLIGHTS = ["bars", "scale", "diverging"] as const
export type SheetHighlight = (typeof SHEET_HIGHLIGHTS)[number]

/** What a sheet's totals row shows under a column, over the rows the reader sees. */
export const SHEET_TOTALS = ["sum", "average", "min", "max", "count"] as const
export type SheetTotal = (typeof SHEET_TOTALS)[number]

export const SHEET_CHART_TYPES = ["bar", "line", "area", "pie"] as const
export type SheetChartType = (typeof SHEET_CHART_TYPES)[number]

export interface SheetColumnFormat {
  readonly type: SheetColumnType
  /** An ISO 4217 code, for a currency column. */
  readonly currency?: string
  /** Digits after the decimal point, for numbers, currencies, and percents. */
  readonly decimals?: number
  /** `1.2M` for `1,204,330`, for numbers and currencies. */
  readonly compact?: boolean
  /** A sign on positive values too, `+3.2%`, for numbers, currencies, and percents. */
  readonly signed?: boolean
  /** A tag column's colors by value. */
  readonly tones?: Readonly<Record<string, SheetTone>>
  /** How a numeric column's cells are shaded by value. */
  readonly highlight?: SheetHighlight
}

export interface WorkbookSheet {
  readonly name: string
  /** Rows that stay in view as the sheet scrolls, the header row included. */
  readonly frozenRows: number
  /** Columns that stay in view as the sheet scrolls sideways. */
  readonly frozenColumns: number
  /** Formats by column name; a column not named here is text. */
  readonly columns: Readonly<Record<string, SheetColumnFormat>>
  /** Widths in pixels by column name. */
  readonly widths: Readonly<Record<string, number>>
  /** What a column means, shown on its header, by column name. */
  readonly descriptions: Readonly<Record<string, string>>
  /** A totals row pinned under the rows: what each named column totals to. */
  readonly totals: Readonly<Record<string, SheetTotal>>
}

export interface WorkbookChart {
  /** What `#chart=<name>` names in an address; lowercase letters, digits, and hyphens. */
  readonly name: string
  readonly type: SheetChartType
  readonly sheet: string
  /** The column along the x axis, or a pie's slice labels. */
  readonly x: string
  /** The plotted columns: one series each, or a pie's one value column. */
  readonly y: readonly string[]
  readonly title?: string
  /** Stack a bar or area chart's series. */
  readonly stacked: boolean
}

export interface Workbook {
  readonly sheets: readonly WorkbookSheet[]
  readonly charts: readonly WorkbookChart[]
}

/** Where a sheet's values are, in the artifact. */
export function sheetFilePath(sheetName: string): string {
  return `sheets/${sheetName}.csv`
}

/**
 * Reads `workbook.json` into its full form: `"Revenue": "currency"` becomes
 * `{ type: "currency" }`, a single `y` becomes a list, and defaults are filled. Returns what is
 * wrong in words the author can act on. Whether the columns exist is checked against the CSVs.
 */
export function parseWorkbook(
  text: string
): { readonly workbook: Workbook } | { readonly error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: `${WORKBOOK_FILE} is not valid JSON.` }
  }
  try {
    return { workbook: readWorkbook(value) }
  } catch (error) {
    if (error instanceof WorkbookError) return { error: `${WORKBOOK_FILE}: ${error.message}` }
    throw error
  }
}

/** A number as a sheet stores it: plain digits, an optional sign, decimals, and exponent. */
export function parseSheetNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(trimmed)) return undefined
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : undefined
}

/** A date as a sheet stores it: `YYYY-MM-DD`, optionally with an ISO 8601 time. */
export function parseSheetDate(value: string): Date | undefined {
  const trimmed = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:\d{2})?)?$/.test(trimmed)) {
    return undefined
  }
  const date = new Date(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed)
  return Number.isNaN(date.getTime()) ? undefined : date
}

class WorkbookError extends Error {}

const SHEET_NAME_MAX = 60
const DESCRIPTION_MAX = 300
const TONES_MAX = 20
const TAG_MAX = 60
const CHART_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const CONTROL = /[\u0000-\u001f\u007f]/

function readWorkbook(value: unknown): Workbook {
  const input = record(value, "the workbook", ["sheets", "charts"])
  if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
    throw new WorkbookError('"sheets" must list at least one sheet.')
  }
  if (input.sheets.length > ARTIFACT_LIMITS.maxSheets) {
    throw new WorkbookError(
      `a workbook holds at most ${ARTIFACT_LIMITS.maxSheets} sheets; this one has ${input.sheets.length}.`
    )
  }
  const sheets = input.sheets.map((sheet, index) => readSheet(sheet, index))
  const names = new Set<string>()
  for (const sheet of sheets) {
    const key = sheet.name.toLowerCase()
    if (names.has(key)) throw new WorkbookError(`two sheets are named '${sheet.name}'.`)
    names.add(key)
  }

  const chartsInput = input.charts ?? []
  if (!Array.isArray(chartsInput)) throw new WorkbookError('"charts" must be a list.')
  if (chartsInput.length > ARTIFACT_LIMITS.maxCharts) {
    throw new WorkbookError(
      `a workbook holds at most ${ARTIFACT_LIMITS.maxCharts} charts; this one has ${chartsInput.length}.`
    )
  }
  const charts = chartsInput.map((chart, index) => readChart(chart, index, sheets))
  const chartNames = new Set<string>()
  for (const chart of charts) {
    if (chartNames.has(chart.name)) throw new WorkbookError(`two charts are named '${chart.name}'.`)
    chartNames.add(chart.name)
  }
  return { sheets, charts }
}

function readSheet(value: unknown, index: number): WorkbookSheet {
  const at = `sheet ${index + 1}`
  const input = record(value, at, [
    "name",
    "frozenRows",
    "frozenColumns",
    "columns",
    "widths",
    "descriptions",
    "totals",
  ])
  const name = typeof input.name === "string" ? input.name.trim() : ""
  if (
    !name ||
    name.length > SHEET_NAME_MAX ||
    CONTROL.test(name) ||
    /[/\\]/.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new WorkbookError(
      `${at} needs a "name" of at most ${SHEET_NAME_MAX} characters without / or \\; its values go in sheets/<name>.csv.`
    )
  }
  const sheetAt = `sheet '${name}'`
  const columns: Record<string, SheetColumnFormat> = {}
  for (const [column, format] of Object.entries(
    record(input.columns ?? {}, `${sheetAt} "columns"`, null)
  )) {
    columns[column] = readColumnFormat(format, `${sheetAt} column '${column}'`)
  }
  const widths: Record<string, number> = {}
  for (const [column, width] of Object.entries(
    record(input.widths ?? {}, `${sheetAt} "widths"`, null)
  )) {
    if (typeof width !== "number" || !Number.isInteger(width) || width < 40 || width > 800) {
      throw new WorkbookError(
        `${sheetAt} gives column '${column}' a width of ${String(width)}; use 40 to 800 pixels.`
      )
    }
    widths[column] = width
  }
  const descriptions: Record<string, string> = {}
  for (const [column, description] of Object.entries(
    record(input.descriptions ?? {}, `${sheetAt} "descriptions"`, null)
  )) {
    if (
      typeof description !== "string" ||
      !description.trim() ||
      description.length > DESCRIPTION_MAX
    ) {
      throw new WorkbookError(
        `${sheetAt} describes column '${column}' with ${JSON.stringify(description)}; a description is text of at most ${DESCRIPTION_MAX} characters.`
      )
    }
    descriptions[column] = description.trim()
  }
  const totals: Record<string, SheetTotal> = {}
  for (const [column, total] of Object.entries(
    record(input.totals ?? {}, `${sheetAt} "totals"`, null)
  )) {
    if (!(SHEET_TOTALS as readonly unknown[]).includes(total)) {
      throw new WorkbookError(
        `${sheetAt} totals column '${column}' with ${JSON.stringify(total)}; use one of ${SHEET_TOTALS.join(", ")}.`
      )
    }
    const type = columns[column]?.type ?? "text"
    if (total !== "count" && !NUMERIC_COLUMN_TYPES.includes(type)) {
      throw new WorkbookError(
        `${sheetAt} totals column '${column}' with "${String(total)}", but it is ${type}; only a number, currency, or percent column has a ${String(total)}. Use "count", or give it a numeric type in "columns".`
      )
    }
    totals[column] = total as SheetTotal
  }
  return {
    name,
    frozenRows: integer(input.frozenRows, 1, 0, 10, `${sheetAt} "frozenRows"`),
    frozenColumns: integer(input.frozenColumns, 0, 0, 5, `${sheetAt} "frozenColumns"`),
    columns,
    widths,
    descriptions,
    totals,
  }
}

function readColumnFormat(value: unknown, at: string): SheetColumnFormat {
  if (typeof value === "string") return { type: columnType(value, at) }
  const input = record(value, at, [
    "type",
    "currency",
    "decimals",
    "compact",
    "signed",
    "tones",
    "highlight",
  ])
  const type = columnType(input.type, at)
  if (input.currency !== undefined) {
    if (type !== "currency")
      throw new WorkbookError(`${at} sets "currency" but is not a currency column.`)
    if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
      throw new WorkbookError(`${at} "currency" must be an ISO 4217 code such as "USD".`)
    }
  }
  if (input.decimals !== undefined && !["number", "currency", "percent"].includes(type)) {
    throw new WorkbookError(
      `${at} sets "decimals" but is not a number, currency, or percent column.`
    )
  }
  for (const [key, types, named] of [
    ["compact", ["number", "currency"], "number or currency"],
    ["signed", ["number", "currency", "percent"], "number, currency, or percent"],
  ] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== "boolean") {
      throw new WorkbookError(`${at} "${key}" must be true or false.`)
    }
    if (!(types as readonly string[]).includes(type)) {
      throw new WorkbookError(`${at} sets "${key}" but is not a ${named} column.`)
    }
  }
  let tones: Record<string, SheetTone> | undefined
  if (input.tones !== undefined) {
    if (type !== "tag") throw new WorkbookError(`${at} sets "tones" but is not a tag column.`)
    tones = {}
    const entries = Object.entries(record(input.tones, `${at} "tones"`, null))
    if (entries.length > TONES_MAX) {
      throw new WorkbookError(
        `${at} "tones" names ${entries.length} values; it takes at most ${TONES_MAX}.`
      )
    }
    for (const [tag, tone] of entries) {
      if (!tag.trim() || tag.length > TAG_MAX) {
        throw new WorkbookError(
          `${at} "tones" names a value of ${tag.length} characters; a tag is 1 to ${TAG_MAX}.`
        )
      }
      if (!(SHEET_TONES as readonly unknown[]).includes(tone)) {
        throw new WorkbookError(
          `${at} gives '${tag}' the tone ${JSON.stringify(tone)}; use one of ${SHEET_TONES.join(", ")}.`
        )
      }
      tones[tag] = tone as SheetTone
    }
  }
  if (input.highlight !== undefined) {
    if (!(SHEET_HIGHLIGHTS as readonly unknown[]).includes(input.highlight)) {
      throw new WorkbookError(
        `${at} "highlight" is ${JSON.stringify(input.highlight)}; use one of ${SHEET_HIGHLIGHTS.join(", ")}.`
      )
    }
    if (!NUMERIC_COLUMN_TYPES.includes(type)) {
      throw new WorkbookError(
        `${at} sets "highlight" but is not a number, currency, or percent column.`
      )
    }
  }
  return {
    type,
    ...(typeof input.currency === "string" ? { currency: input.currency } : {}),
    ...(input.compact === true ? { compact: true } : {}),
    ...(input.signed === true ? { signed: true } : {}),
    ...(tones ? { tones } : {}),
    ...(input.highlight === undefined ? {} : { highlight: input.highlight as SheetHighlight }),
    ...(input.decimals === undefined
      ? {}
      : { decimals: integer(input.decimals, 0, 0, 6, `${at} "decimals"`) }),
  }
}

function columnType(value: unknown, at: string): SheetColumnType {
  if (typeof value === "string" && (SHEET_COLUMN_TYPES as readonly string[]).includes(value)) {
    return value as SheetColumnType
  }
  throw new WorkbookError(
    `${at} has type ${JSON.stringify(value)}; use one of ${SHEET_COLUMN_TYPES.join(", ")}.`
  )
}

function readChart(value: unknown, index: number, sheets: readonly WorkbookSheet[]): WorkbookChart {
  const input = record(value, `chart ${index + 1}`, [
    "name",
    "type",
    "sheet",
    "x",
    "y",
    "title",
    "stacked",
  ])
  if (typeof input.name !== "string" || !CHART_NAME.test(input.name)) {
    throw new WorkbookError(
      `chart ${index + 1} needs a "name" of lowercase letters, digits, and hyphens, such as "revenue".`
    )
  }
  const at = `chart '${input.name}'`
  if (!(SHEET_CHART_TYPES as readonly unknown[]).includes(input.type)) {
    throw new WorkbookError(
      `${at} has type ${JSON.stringify(input.type)}; use one of ${SHEET_CHART_TYPES.join(", ")}.`
    )
  }
  const type = input.type as SheetChartType
  if (typeof input.sheet !== "string" || !sheets.some((sheet) => sheet.name === input.sheet)) {
    throw new WorkbookError(
      `${at} names sheet ${JSON.stringify(input.sheet)}, which the workbook does not have.`
    )
  }
  if (typeof input.x !== "string" || !input.x) throw new WorkbookError(`${at} needs an "x" column.`)
  const y = typeof input.y === "string" ? [input.y] : input.y
  if (
    !Array.isArray(y) ||
    y.length === 0 ||
    !y.every((column) => typeof column === "string" && column)
  ) {
    throw new WorkbookError(`${at} needs a "y" column, or a list of them.`)
  }
  if (y.length > ARTIFACT_LIMITS.maxChartSeries) {
    throw new WorkbookError(
      `${at} plots ${y.length} columns; a chart reads well with at most ${ARTIFACT_LIMITS.maxChartSeries}. Split it, or chart the ones that matter.`
    )
  }
  if (type === "pie" && y.length !== 1)
    throw new WorkbookError(`${at} is a pie: give it one "y" column.`)
  if (input.stacked !== undefined && typeof input.stacked !== "boolean") {
    throw new WorkbookError(`${at} "stacked" must be true or false.`)
  }
  if (input.stacked === true && type !== "bar" && type !== "area") {
    throw new WorkbookError(`${at} is a ${type} chart; only bar and area charts stack.`)
  }
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 120)) {
    throw new WorkbookError(`${at} "title" must be text of at most 120 characters.`)
  }
  return {
    name: input.name,
    type,
    sheet: input.sheet,
    x: input.x,
    y: y as string[],
    ...(typeof input.title === "string" && input.title.trim() ? { title: input.title.trim() } : {}),
    stacked: input.stacked === true,
  }
}

function record(
  value: unknown,
  at: string,
  keys: readonly string[] | null
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkbookError(`${at} must be an object.`)
  }
  const input = value as Record<string, unknown>
  const unknownKey = keys && Object.keys(input).find((key) => !keys.includes(key))
  if (unknownKey) {
    throw new WorkbookError(
      `${at} has '${unknownKey}'; it takes ${keys.map((key) => `"${key}"`).join(", ")}.`
    )
  }
  return input
}

function integer(value: unknown, fallback: number, min: number, max: number, at: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new WorkbookError(`${at} must be a whole number from ${min} to ${max}.`)
  }
  return value
}
