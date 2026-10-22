import {
  type CsvTable,
  checkFormula,
  checkSheet,
  columnFormulaType,
  evaluateComputedColumns,
  FormulaCycleError,
  type FormulaType,
  formatCsv,
  formulaDependencies,
  formulaFitsColumn,
  NUMERIC_COLUMN_TYPES,
  parseFormula,
  renameColumnReferences,
  type SheetColumnFormat,
  type SheetTotal,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookSheet,
} from "@sixb/core/artifacts"
import type { CellInput } from "./input"
import { type SheetModel, sheetModel } from "./model"

/**
 * A workbook as a person is editing it: its layout, and the tables of the sheets they changed,
 * over the version they started from. A draft never changes; each edit makes the next one, so a
 * row nobody touched is the very array the version's table holds.
 */
export interface WorkbookDraft {
  /** The version's workbook, which the draft started from. */
  readonly original: Workbook
  readonly workbook: Workbook
  /** The sheets changed, by name, each table whole. */
  readonly tables: ReadonlyMap<string, CsvTable>
}

/** A value to store in a cell: its data row (the table's row index from 0) and column. */
export interface CellEdit {
  readonly row: number
  readonly column: number
  readonly value: string
}

/** Why a change to a column can't be made, in terms the reader can act on. */
export type ColumnRefusal =
  | { readonly refused: "name-empty" }
  | { readonly refused: "name-taken"; readonly name: string }
  /** A chart plots the column, so it can't go. */
  | { readonly refused: "charted"; readonly by: string }
  /** Another column's formula reads it. */
  | { readonly refused: "computed-from"; readonly by: string }
  /** Values that don't fit the type asked for. */
  | { readonly refused: "values"; readonly count: number }
  /** A formula that doesn't parse, or names what the sheet lacks: the parser's words. */
  | { readonly refused: "formula"; readonly message: string }
  /** A formula whose result the column's type can't show. */
  | { readonly refused: "formula-type"; readonly computes: FormulaType }
  /** Columns that would compute from each other. */
  | { readonly refused: "formula-cycle" }
  /** A change that would leave the sheet one publishing refuses: the rule broken, in its words. */
  | { readonly refused: "invalid"; readonly message: string }

/** A column's name and form, as the column's settings set them. */
export interface ColumnSettings {
  readonly name: string
  readonly format: SheetColumnFormat
  readonly description?: string
  readonly total?: SheetTotal
}

/**
 * The row of the version's table each edited row was made from; a row added in the draft has
 * none. Rows the draft never touched are not here: they are the version's own.
 */
const ORIGINS = new WeakMap<readonly string[], readonly string[] | null>()

/**
 * The version's column each of a table's columns was made from, by index; a column the draft
 * added has none. A table not here has the version's columns, in its order.
 */
const COLUMNS = new WeakMap<CsvTable, readonly (number | null)[]>()

export function startDraft(workbook: Workbook): WorkbookDraft {
  return { original: workbook, workbook, tables: new Map() }
}

/** A sheet's table in the draft: as edited, or the version's when the draft hasn't changed it. */
export function draftTable(draft: WorkbookDraft, sheet: string, base: CsvTable): CsvTable {
  return draft.tables.get(sheet) ?? base
}

/** A sheet's layout in the draft: its formats, widths, totals, and descriptions as edited. */
export function draftSheet(draft: WorkbookDraft, sheet: string): WorkbookSheet | undefined {
  return draft.workbook.sheets.find((entry) => entry.name === sheet)
}

/**
 * Stores values in a sheet's cells. A value the cell already holds changes nothing. `grow` adds
 * empty rows at the end and columns at the right first, as a paste past the sheet's edge does,
 * so edits may name rows and columns past the table's.
 */
export function setCells(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  edits: readonly CellEdit[],
  grow: { readonly rows: number; readonly columns: number } = { rows: 0, columns: 0 }
): WorkbookDraft {
  const grown = grownTable(draftTable(draft, sheet, base), grow)
  const table = grown ?? draftTable(draft, sheet, base)
  const changed = new Map<number, string[]>()
  for (const edit of edits) {
    const row = table.rows[edit.row]
    if (!row || edit.column < 0 || edit.column >= table.header.length) continue
    const current = changed.get(edit.row) ?? row
    if ((current[edit.column] ?? "") === edit.value) continue
    const next = changed.get(edit.row) ?? editedRow(row, table.header.length)
    next[edit.column] = edit.value
    changed.set(edit.row, next)
  }
  if (changed.size === 0 && !grown) return draft
  const rows = table.rows.map((row, index) => changed.get(index) ?? row)
  return withTable(draft, sheet, derivedTable(table, table.header, rows))
}

/** Adds empty rows before a data row; at the table's length, after the last. */
export function insertRows(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  at: number,
  count: number
): WorkbookDraft {
  const table = draftTable(draft, sheet, base)
  if (count <= 0) return draft
  const index = Math.max(0, Math.min(at, table.rows.length))
  const added = Array.from({ length: count }, () => addedRow(table.header.length))
  return withTable(
    draft,
    sheet,
    derivedTable(table, table.header, [
      ...table.rows.slice(0, index),
      ...added,
      ...table.rows.slice(index),
    ])
  )
}

/** Removes data rows; a sheet keeps at least its header. */
export function deleteRows(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  rows: readonly number[]
): WorkbookDraft {
  const table = draftTable(draft, sheet, base)
  const removed = new Set(rows)
  if (![...removed].some((row) => row >= 0 && row < table.rows.length)) return draft
  return withTable(
    draft,
    sheet,
    derivedTable(
      table,
      table.header,
      table.rows.filter((_, index) => !removed.has(index))
    )
  )
}

/** Adds an empty text column before a column; at the column count, after the last. */
export function insertColumn(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  at: number
): WorkbookDraft {
  const table = draftTable(draft, sheet, base)
  const index = Math.max(0, Math.min(at, table.header.length))
  const name = newColumnNames(table.header, 1)[0] as string
  const header = [...table.header.slice(0, index), name, ...table.header.slice(index)]
  const rows = table.rows.map((row) => {
    const next = editedRow(row, table.header.length)
    next.splice(index, 0, "")
    return next
  })
  const columns = [...columnsOf(table)]
  columns.splice(index, 0, null)
  return withTable(draft, sheet, registered({ header, rows }, columns))
}

/**
 * Removes a column, with its format, width, total, and description. A column a chart plots or a
 * formula reads is refused, naming the chart or the column: removing it would break them.
 */
export function deleteColumn(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  column: number
): WorkbookDraft | ColumnRefusal {
  const table = draftTable(draft, sheet, base)
  const name = table.header[column]
  if (name === undefined) return draft
  const blocked = columnUse(draft.workbook, sheet, name)
  if (blocked) return blocked
  const header = table.header.filter((_, index) => index !== column)
  const rows = table.rows.map((row) => {
    const next = editedRow(row, table.header.length)
    next.splice(column, 1)
    return next
  })
  const columns = columnsOf(table).filter((_, index) => index !== column)
  const workbook = updateSheet(draft.workbook, sheet, (entry) => ({
    ...entry,
    columns: omit(entry.columns, name),
    widths: omit(entry.widths, name),
    descriptions: omit(entry.descriptions, name),
    totals: omit(entry.totals, name),
  }))
  return withTable({ ...draft, workbook }, sheet, registered({ header, rows }, columns))
}

/**
 * Sets a column's name and form as one change. A new name carries the column's format, width,
 * total, and description, and every chart and formula that names it. A new type converts the
 * values that read as it, and is refused when any don't; a formula is checked against the sheet's
 * columns and computes the column's values from then on; taking a formula away keeps the values it
 * computed. A change the sheet's charts or other formulas can't take is refused, as publishing
 * would refuse it. `read` reads a value as the new type stores it.
 */
export function setColumn(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  column: number,
  settings: ColumnSettings,
  read: (value: string, format: SheetColumnFormat) => CellInput
): WorkbookDraft | ColumnRefusal {
  const table = draftTable(draft, sheet, base)
  const layout = draftSheet(draft, sheet)
  const from = table.header[column]
  if (from === undefined || !layout) return draft
  const name = settings.name.trim()
  if (!name) return { refused: "name-empty" }
  if (name !== from && table.header.includes(name)) return { refused: "name-taken", name }
  const before = layout.columns[from] ?? { type: "text" as const }
  const format = settings.format

  let values: string[] = table.rows.map((row) => row[column] ?? "")
  if (format.formula) {
    const checked = checkColumnFormula(layout, table, from, format)
    if (checked) return checked
    values = values.map(() => "")
  } else {
    if (before.formula) {
      // The values the formula computed become the column's own.
      values = evaluateComputedColumns(layout, table).table.rows.map((row) => row[column] ?? "")
    }
    if (format.type !== before.type || before.formula) {
      let misfits = 0
      values = values.map((value) => {
        if (!value.trim()) return ""
        const converted = read(value, format)
        if ("error" in converted) {
          misfits += 1
          return value
        }
        return converted.value
      })
      if (misfits > 0) return { refused: "values", count: misfits }
    }
  }

  const rows = table.rows.map((row, index) => {
    const value = values[index] ?? ""
    if ((row[column] ?? "") === value) return row
    const next = editedRow(row, table.header.length)
    next[column] = value
    return next
  })
  const header = table.header.map((entry, index) => (index === column ? name : entry))
  let workbook = updateSheet(draft.workbook, sheet, (entry) => {
    const renamed = name === from ? entry : renameInSheet(entry, from, name)
    const plain = format.type === "text" && Object.keys(format).length === 1
    const total =
      settings.total && (settings.total === "count" || NUMERIC_COLUMN_TYPES.includes(format.type))
        ? settings.total
        : undefined
    return {
      ...renamed,
      columns: plain ? omit(renamed.columns, name) : { ...renamed.columns, [name]: format },
      descriptions: settings.description?.trim()
        ? { ...renamed.descriptions, [name]: settings.description.trim() }
        : omit(renamed.descriptions, name),
      totals: total ? { ...renamed.totals, [name]: total } : omit(renamed.totals, name),
    }
  })
  if (name !== from) {
    workbook = {
      ...workbook,
      charts: workbook.charts.map((chart) =>
        chart.sheet === sheet
          ? {
              ...chart,
              x: chart.x === from ? name : chart.x,
              y: chart.y.map((entry) => (entry === from ? name : entry)),
              line: chart.line.map((entry) => (entry === from ? name : entry)),
            }
          : chart
      ),
    }
  }
  const unchanged =
    header.every((entry, index) => entry === table.header[index]) &&
    rows.every((row, index) => row === table.rows[index]) &&
    JSON.stringify(workbook) === JSON.stringify(draft.workbook)
  if (unchanged) return draft

  // The charts that plot the column, and the formulas that read it, must still hold.
  const next = withTable({ ...draft, workbook }, sheet, derivedTable(table, header, rows))
  return sheetRefusal(next, sheet, base) ?? next
}

/**
 * Why a draft's sheet is one publishing would refuse, by the rules publishing checks it with: its
 * columns, its formulas, and the charts on it. Null when it publishes.
 */
export function sheetRefusal(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable
): ColumnRefusal | null {
  const message = checkSheet(draft.workbook, new Map([[sheet, draftTable(draft, sheet, base)]]))
  return message ? { refused: "invalid", message } : null
}

/** A sheet's column in use: by a chart that plots it, or a formula that reads it. */
function columnUse(workbook: Workbook, sheet: string, name: string): ColumnRefusal | null {
  const chart = workbook.charts.find(
    (entry) => entry.sheet === sheet && [entry.x, ...entry.y, ...entry.line].includes(name)
  )
  if (chart) return { refused: "charted", by: chart.title ?? chart.name }
  const layout = workbook.sheets.find((entry) => entry.name === sheet)
  for (const [column, format] of Object.entries(layout?.columns ?? {})) {
    if (column === name || !format.formula) continue
    try {
      if (formulaDependencies(parseFormula(format.formula)).has(name)) {
        return { refused: "computed-from", by: column }
      }
    } catch {
      // Publishing refused formulas that don't parse: none reach a draft.
    }
  }
  return null
}

/** What is wrong with a column's new formula: in words, or null when it computes. */
function checkColumnFormula(
  layout: WorkbookSheet,
  table: CsvTable,
  column: string,
  format: SheetColumnFormat
): ColumnRefusal | null {
  const formula = format.formula ?? ""
  let node: ReturnType<typeof parseFormula>
  try {
    node = parseFormula(formula)
  } catch (error) {
    return { refused: "formula", message: (error as Error).message }
  }
  const types = new Map<string, FormulaType>(
    table.header
      .filter((name) => name !== column)
      .map((name) => [name, columnFormulaType(layout.columns[name]?.type ?? "text")])
  )
  const checked = checkFormula(node, types)
  if ("error" in checked) return { refused: "formula", message: checked.error }
  if (!formulaFitsColumn(checked.type, format.type)) {
    return { refused: "formula-type", computes: checked.type }
  }
  try {
    evaluateComputedColumns({ columns: { ...layout.columns, [column]: format } }, table)
  } catch (error) {
    if (error instanceof FormulaCycleError) return { refused: "formula-cycle" }
    throw error
  }
  return null
}

/** A sheet's layout with a column's name changed in every entry and formula that names it. */
function renameInSheet(sheet: WorkbookSheet, from: string, to: string): WorkbookSheet {
  const columns: Record<string, SheetColumnFormat> = {}
  for (const [name, format] of Object.entries(sheet.columns)) {
    columns[name === from ? to : name] = format.formula
      ? { ...format, formula: renameColumnReferences(format.formula, from, to) }
      : format
  }
  return {
    ...sheet,
    columns,
    widths: renamed(sheet.widths, from, to),
    descriptions: renamed(sheet.descriptions, from, to),
    totals: renamed(sheet.totals, from, to),
  }
}

/** Names for columns the draft adds: `Column 7`, the next number free. */
export function newColumnNames(header: readonly string[], count: number): string[] {
  const taken = new Set(header)
  const names: string[] = []
  for (let number = header.length + 1; names.length < count; number += 1) {
    const name = `Column ${number}`
    if (!taken.has(name)) names.push(name)
  }
  return names
}

/**
 * Whether a cell holds a value the draft changed: one that differs from the version's in the row
 * and column it was made from, or any value at all in a row or column the draft added.
 */
export function cellEdited(table: CsvTable, row: number, column: number): boolean {
  const values = table.rows[row]
  if (!values) return false
  const origin = ORIGINS.get(values)
  if (origin === undefined) return false
  const source = columnsOf(table)[column]
  const before = origin === null || source === null || source === undefined ? "" : origin[source]
  return (before ?? "") !== (values[column] ?? "")
}

/**
 * The sheet as the grid draws it from the draft: its computed columns filled again, and each
 * column as wide as the version drew it and at its decimals, so a column doesn't change its form
 * as its values change.
 */
export function draftModel(sheet: WorkbookSheet, table: CsvTable, base: SheetModel): SheetModel {
  const model = sheetModel(sheet, table)
  const sources = columnsOf(table)
  return {
    ...model,
    columns: model.columns.map((column, index) => {
      const source = sources[index]
      const before = source === null || source === undefined ? undefined : base.columns[source]
      // A width the layout sets, as a rename carries it, wins over the one the version drew.
      if (!before || sheet.widths[column.name] !== undefined) return column
      return {
        ...column,
        width: before.width,
        ...(before.format.type === column.format.type ? { decimals: before.decimals } : {}),
      }
    }),
  }
}

/** Whether the draft holds anything to save: a table or a layout that isn't the version's. */
export function draftChanged(draft: WorkbookDraft): boolean {
  return draft.tables.size > 0 || draft.workbook !== draft.original
}

/** The files a save publishes, by their paths: each changed sheet's CSV, and the workbook's. */
export function draftFiles(draft: WorkbookDraft): Map<string, string> {
  const files = new Map<string, string>()
  for (const [sheet, table] of draft.tables) {
    files.set(sheetFilePath(sheet), formatCsv(table.header, table.rows))
  }
  if (draft.workbook !== draft.original) files.set(WORKBOOK_FILE, formatWorkbook(draft.workbook))
  return files
}

/**
 * A workbook as `workbook.json` writes it, the inverse of `parseWorkbook`: only what isn't a
 * default, a format of a type alone as its type's name, so the file reads as an author writes it.
 */
export function formatWorkbook(workbook: Workbook): string {
  const sheets = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    ...(sheet.frozenRows === 1 ? {} : { frozenRows: sheet.frozenRows }),
    ...(sheet.frozenColumns === 0 ? {} : { frozenColumns: sheet.frozenColumns }),
    ...nonEmpty(
      "columns",
      Object.fromEntries(
        Object.entries(sheet.columns).map(([name, format]) => [
          name,
          Object.keys(format).length === 1 ? format.type : format,
        ])
      )
    ),
    ...nonEmpty("widths", sheet.widths),
    ...nonEmpty("descriptions", sheet.descriptions),
    ...nonEmpty("totals", sheet.totals),
  }))
  const charts = workbook.charts.map((chart) => ({
    name: chart.name,
    type: chart.type,
    sheet: chart.sheet,
    x: chart.x,
    ...(chart.y.length === 0 ? {} : { y: chart.y.length === 1 ? chart.y[0] : chart.y }),
    ...(chart.line.length === 0 ? {} : { line: chart.line }),
    ...(chart.aggregate ? { aggregate: chart.aggregate } : {}),
    ...(chart.title ? { title: chart.title } : {}),
    ...(chart.stacked ? { stacked: true } : {}),
  }))
  return `${JSON.stringify({ sheets, ...(charts.length > 0 ? { charts } : {}) }, null, 2)}\n`
}

function nonEmpty<Key extends string>(key: Key, record: Readonly<Record<string, unknown>>) {
  return Object.keys(record).length > 0 ? ({ [key]: record } as Record<Key, unknown>) : {}
}

function omit<Value>(record: Readonly<Record<string, Value>>, key: string): Record<string, Value> {
  const { [key]: _, ...rest } = record
  return rest
}

function renamed<Value>(
  record: Readonly<Record<string, Value>>,
  from: string,
  to: string
): Record<string, Value> {
  return Object.fromEntries(
    Object.entries(record).map(([name, value]) => [name === from ? to : name, value])
  )
}

function updateSheet(
  workbook: Workbook,
  sheet: string,
  update: (sheet: WorkbookSheet) => WorkbookSheet
): Workbook {
  return {
    ...workbook,
    sheets: workbook.sheets.map((entry) => (entry.name === sheet ? update(entry) : entry)),
  }
}

function columnsOf(table: CsvTable): readonly (number | null)[] {
  return COLUMNS.get(table) ?? table.header.map((_, index) => index)
}

function registered(table: CsvTable, columns: readonly (number | null)[]): CsvTable {
  COLUMNS.set(table, columns)
  return table
}

/** A table made from another, with its columns where they were and any it adds past them. */
function derivedTable(
  from: CsvTable,
  header: readonly string[],
  rows: readonly (readonly string[])[]
): CsvTable {
  const columns = [...columnsOf(from)]
  while (columns.length < header.length) columns.push(null)
  return registered({ header: [...header], rows: [...rows] as string[][] }, columns)
}

function editedRow(row: readonly string[], width: number): string[] {
  const next = [...row]
  while (next.length < width) next.push("")
  // An edited row keeps the origin of the row it was made from: the version's, or none.
  const origin = ORIGINS.get(row)
  ORIGINS.set(next, origin === undefined ? row : origin)
  return next
}

function addedRow(width: number): string[] {
  const row = Array.from({ length: width }, () => "")
  ORIGINS.set(row, null)
  return row
}

/** The table with empty rows and named columns added; null when nothing grows. */
function grownTable(
  table: CsvTable,
  grow: { readonly rows: number; readonly columns: number }
): CsvTable | null {
  if (grow.rows <= 0 && grow.columns <= 0) return null
  const header = [...table.header, ...newColumnNames(table.header, Math.max(0, grow.columns))]
  const rows = table.rows.map((row) => (grow.columns > 0 ? editedRow(row, header.length) : row))
  for (let index = 0; index < grow.rows; index += 1) rows.push(addedRow(header.length))
  return derivedTable(table, header, rows)
}

function withTable(draft: WorkbookDraft, sheet: string, table: CsvTable): WorkbookDraft {
  const tables = new Map(draft.tables)
  tables.set(sheet, table)
  return { ...draft, tables }
}
