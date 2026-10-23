import { FormulaSyntaxError, parseFormula } from "./formula/parser"
import { ARTIFACT_LIMITS } from "./limits"
import { isArtifactQueryName } from "./queries"
import { ARTIFACT_TONES, type ArtifactTone, isArtifactTone } from "./tones"

/**
 * A sheet artifact is `workbook.json` and one CSV per sheet under `sheets/`. The CSV holds the
 * values; the workbook holds what CSV can't: sheet order, column types and formats, frozen rows
 * and columns, widths, descriptions and totals, computed columns' formulas, and charts drawn from
 * the sheets. A live sheet has no CSV: its rows are one of the version's queries', as each reader
 * reads them.
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
 * How a numeric column's cells are shaded by value, across the column: a bar in the cell, a
 * shade from light to dark, or two colors either side of zero.
 */
export const SHEET_HIGHLIGHTS = ["bars", "scale", "diverging"] as const
export type SheetHighlight = (typeof SHEET_HIGHLIGHTS)[number]

/** What a sheet's totals row shows under a column, over the rows the reader sees. */
export const SHEET_TOTALS = ["sum", "average", "min", "max", "count"] as const
export type SheetTotal = (typeof SHEET_TOTALS)[number]

export const SHEET_CHART_TYPES = ["bar", "line", "area", "pie", "scatter"] as const
export type SheetChartType = (typeof SHEET_CHART_TYPES)[number]

/** How a chart summarizes rows that share an x value: one point or slice for each value. */
export const SHEET_CHART_AGGREGATES = ["sum", "average", "count"] as const
export type SheetChartAggregate = (typeof SHEET_CHART_AGGREGATES)[number]

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
  /** A tag column's colors by value; a value not named is neutral. */
  readonly tones?: Readonly<Record<string, ArtifactTone>>
  /** How a numeric column's cells are shaded by value. */
  readonly highlight?: SheetHighlight
  /** The formula that computes the column's every value, as an Excel table's column does. */
  readonly formula?: string
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
  /** Where a live sheet's rows and columns come from; a sheet without it holds its CSV's. */
  readonly live?: LiveSheetSource
}

/**
 * A live sheet's query and columns. Its columns are exactly those its workbook lists, in order,
 * each showing a property of the rows or computed by a formula. A column whose type is its
 * property's has no format in `columns` until the property's type is known: `liveSheetColumns`
 * reads it then.
 */
export interface LiveSheetSource {
  /** The query whose rows the sheet shows: `queries/<name>.json` in the version. */
  readonly query: string
  readonly columns: readonly LiveSheetColumnSource[]
}

export interface LiveSheetColumnSource {
  readonly name: string
  /**
   * The property the column shows: a property id of the rows, or `<linkId>.<propertyId>` of a
   * link the query expands. A computed column has none.
   */
  readonly from?: string
  /** The column's format as written, when it gives no type: its property's type is its type. */
  readonly untyped?: Readonly<Record<string, unknown>>
}

export interface WorkbookChart {
  /** What `#chart=<name>` names in an address; lowercase letters, digits, and hyphens. */
  readonly name: string
  readonly type: SheetChartType
  readonly sheet: string
  /** The column along the x axis, or a pie's slice labels. */
  readonly x: string
  /**
   * The plotted columns: one series each, or a pie's one value column. Empty for a chart that
   * counts rows.
   */
  readonly y: readonly string[]
  /** A bar chart's columns drawn as lines over its bars. */
  readonly line: readonly string[]
  /** Rows summarized by their x value, in the order the values first appear. */
  readonly aggregate?: SheetChartAggregate
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
 * wrong in words the author can act on. Whether the columns exist is checked against the CSVs, and
 * a live sheet's against its query.
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
const FORMULA_MAX = 500
const COMPUTED_MAX = 20
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
    "query",
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
  const live = input.query === undefined ? undefined : readLiveSheet(input, sheetAt)
  const columns: Record<string, SheetColumnFormat> = {}
  for (const [column, format] of Object.entries(
    record(input.columns ?? {}, `${sheetAt} "columns"`, null)
  )) {
    const at = `${sheetAt} column '${column}'`
    if (!live) {
      columns[column] = readColumnFormat(format, at)
      continue
    }

    // A live column's `from` is its source, not its format; without a type, its property's is.
    const { from: _from, ...written } = format as Record<string, unknown>
    if (written.type !== undefined || written.formula !== undefined) {
      columns[column] = readColumnFormat(written, at)
    }
  }
  const computed = Object.values(columns).filter((format) => format.formula).length
  if (computed > COMPUTED_MAX) {
    throw new WorkbookError(
      `${sheetAt} computes ${computed} columns; a sheet computes at most ${COMPUTED_MAX}.`
    )
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
    // A live column typed by its property is checked once its property's type is known, and one
    // the sheet does not list once its columns are.
    const deferred = live !== undefined && columns[column] === undefined
    const problem = deferred
      ? null
      : sheetTotalProblem(sheetAt, column, total as SheetTotal, columns[column]?.type ?? "text")
    if (problem) throw new WorkbookError(problem)
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
    ...(live ? { live } : {}),
  }
}

/** Why a column can't have its total, or null: only a numeric column has more than a count. */
export function sheetTotalProblem(
  sheetAt: string,
  column: string,
  total: SheetTotal,
  type: SheetColumnType
): string | null {
  if (total === "count" || NUMERIC_COLUMN_TYPES.includes(type)) return null
  return `${sheetAt} totals column '${column}' with "${total}", but it is ${type}; only a number, currency, or percent column has a ${total}. Use "count", or give it a numeric type in "columns".`
}

/** A JSON object puts a name such as `2024` before the others, whatever order it was written in. */
const INDEX_NAME = /^(0|[1-9]\d{0,8})$/

/**
 * A live sheet's query and columns. Each column shows a property, `from`, or is computed, in the
 * order `columns` lists them, so a name JSON would move is refused.
 */
function readLiveSheet(input: Record<string, unknown>, sheetAt: string): LiveSheetSource {
  if (typeof input.query !== "string" || !isArtifactQueryName(input.query)) {
    throw new WorkbookError(
      `${sheetAt} "query" must name one of the version's queries, as queries/<name>.json names it: lowercase letters, digits and hyphens.`
    )
  }

  const entries = Object.entries(record(input.columns ?? {}, `${sheetAt} "columns"`, null))
  if (entries.length === 0) {
    throw new WorkbookError(
      `${sheetAt} reads query '${input.query}': list its columns in "columns", each with the property it shows in "from".`
    )
  }

  const columns = entries.map(([name, value]): LiveSheetColumnSource => {
    const at = `${sheetAt} column '${name}'`
    if (INDEX_NAME.test(name)) {
      throw new WorkbookError(
        `${at}: a live sheet's columns come in the order "columns" lists them, and JSON puts a name of digits first. Name it with a letter, such as "FY${name}".`
      )
    }

    if (typeof value === "string") {
      throw new WorkbookError(
        `${at} is ${JSON.stringify(value)}; a live sheet's column is an object, such as { "from": "amount", "type": "${value}" }.`
      )
    }
    const column = record(value, at, [
      "from",
      "type",
      "currency",
      "decimals",
      "compact",
      "signed",
      "tones",
      "highlight",
      "formula",
    ])
    if (column.from === undefined && column.formula === undefined) {
      throw new WorkbookError(
        `${at} shows nothing: give it "from", the property it shows, or a "formula".`
      )
    }
    if (column.from !== undefined && column.formula !== undefined) {
      throw new WorkbookError(
        `${at} has both "from" and "formula": a column shows a property or computes, not both.`
      )
    }
    if (column.from === undefined) return { name }

    const from = column.from
    const segments = typeof from === "string" ? from.split(".") : []
    if (segments.length === 0 || segments.some((segment) => !segment)) {
      throw new WorkbookError(
        `${at} "from" must name a property of the rows, such as "amount", or of a link the query expands, such as "customer.name".`
      )
    }
    if (segments.length > 2) {
      throw new WorkbookError(
        `${at} "from" is ${JSON.stringify(from)}; a column reads a property of the rows or of one link the query expands, such as "customer.name".`
      )
    }

    const { from: _from, ...untyped } = column
    return { name, from: from as string, ...(column.type === undefined ? { untyped } : {}) }
  })

  return { query: input.query, columns }
}

/**
 * A column's format as `columns` writes it, for a column whose type `type` gives when the format
 * names none: a live column's property's. Returns what is wrong in the words parsing uses.
 */
export function readSheetColumnFormat(
  value: Readonly<Record<string, unknown>>,
  at: string,
  type: SheetColumnType
): { readonly format: SheetColumnFormat } | { readonly error: string } {
  try {
    return { format: readColumnFormat({ type, ...value }, at) }
  } catch (error) {
    if (error instanceof WorkbookError) return { error: `${WORKBOOK_FILE}: ${error.message}` }
    throw error
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
    "formula",
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
  let tones: Record<string, ArtifactTone> | undefined
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
      if (!isArtifactTone(tone)) {
        throw new WorkbookError(
          `${at} gives '${tag}' the tone ${JSON.stringify(tone)}; use one of ${ARTIFACT_TONES.join(", ")}.`
        )
      }
      tones[tag] = tone as ArtifactTone
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
  let formula: string | undefined
  if (input.formula !== undefined) {
    if (typeof input.formula !== "string" || !input.formula.trim()) {
      throw new WorkbookError(`${at} "formula" must be text, such as "[@Revenue]-[@Cost]".`)
    }
    if (input.formula.length > FORMULA_MAX) {
      throw new WorkbookError(
        `${at} "formula" is ${input.formula.length} characters; a formula is at most ${FORMULA_MAX}.`
      )
    }
    if (type === "link" || type === "image") {
      throw new WorkbookError(`${at} is a ${type} column, which a formula can't compute.`)
    }
    formula = input.formula.trim().replace(/^=/, "")
    try {
      parseFormula(formula)
    } catch (error) {
      if (error instanceof FormulaSyntaxError) {
        throw new WorkbookError(`${at} "formula" does not read: ${error.message}`)
      }
      throw error
    }
  }
  return {
    type,
    ...(typeof input.currency === "string" ? { currency: input.currency } : {}),
    ...(formula ? { formula } : {}),
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
    "line",
    "aggregate",
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
  if (
    input.aggregate !== undefined &&
    !(SHEET_CHART_AGGREGATES as readonly unknown[]).includes(input.aggregate)
  ) {
    throw new WorkbookError(
      `${at} "aggregate" is ${JSON.stringify(input.aggregate)}; use one of ${SHEET_CHART_AGGREGATES.join(", ")}.`
    )
  }
  const aggregate = input.aggregate as SheetChartAggregate | undefined
  if (aggregate && type === "scatter") {
    throw new WorkbookError(
      `${at} is a scatter chart, which plots every row; leave out "aggregate".`
    )
  }
  const columns = (key: "y" | "line") => {
    const value = input[key]
    const list = typeof value === "string" ? [value] : (value ?? [])
    if (!Array.isArray(list) || !list.every((column) => typeof column === "string" && column)) {
      throw new WorkbookError(`${at} "${key}" must be a column, or a list of them.`)
    }
    return list as string[]
  }
  const y = columns("y")
  const line = columns("line")
  // Counting rows plots how many there are for each x value: there is no column to plot.
  if (aggregate === "count") {
    if (y.length > 0 || line.length > 0) {
      throw new WorkbookError(`${at} counts rows, which needs no "y"; leave it out.`)
    }
  } else if (y.length === 0) {
    throw new WorkbookError(`${at} needs a "y" column, or a list of them.`)
  }
  if (line.length > 0 && type !== "bar") {
    throw new WorkbookError(
      `${at} is a ${type} chart; only a bar chart draws "line" columns over its bars.`
    )
  }
  if (y.length + line.length > ARTIFACT_LIMITS.maxChartSeries) {
    throw new WorkbookError(
      `${at} plots ${y.length + line.length} columns; a chart reads well with at most ${ARTIFACT_LIMITS.maxChartSeries}. Split it, or chart the ones that matter.`
    )
  }
  if (type === "pie" && aggregate !== "count" && y.length !== 1)
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
    y,
    line,
    ...(aggregate ? { aggregate } : {}),
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
