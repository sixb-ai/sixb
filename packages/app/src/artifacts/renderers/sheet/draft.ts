import {
  type CsvTable,
  formatCsv,
  sheetFilePath,
  type Workbook,
  type WorkbookSheet,
} from "@sixb/core/artifacts"
import { type SheetModel, sheetModel } from "./model"

/**
 * A workbook as a person is editing it: the tables of the sheets they changed, over the version
 * they started from. A draft never changes; each edit makes the next one, so a row nobody touched
 * is the very array the version's table holds.
 */
export interface WorkbookDraft {
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

/**
 * The row of the version's table each edited row was made from; a row added in the draft has
 * none. Rows the draft never touched are not here: they are the version's own.
 */
const ORIGINS = new WeakMap<readonly string[], readonly string[] | null>()

export function startDraft(workbook: Workbook): WorkbookDraft {
  return { workbook, tables: new Map() }
}

/** A sheet's table in the draft: as edited, or the version's when the draft hasn't changed it. */
export function draftTable(draft: WorkbookDraft, sheet: string, base: CsvTable): CsvTable {
  return draft.tables.get(sheet) ?? base
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
  return withTable(draft, sheet, { header: table.header, rows })
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
  return withTable(draft, sheet, {
    header: table.header,
    rows: [...table.rows.slice(0, index), ...added, ...table.rows.slice(index)],
  })
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
  return withTable(draft, sheet, {
    header: table.header,
    rows: table.rows.filter((_, index) => !removed.has(index)),
  })
}

/** Names for columns a paste adds past the last: `Column 7`, the next number free. */
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
 * Every change of a draft in order, so each can be undone and done again. A change made after an
 * undo drops what was undone, as an editor's does.
 */
export interface DraftHistory {
  readonly past: readonly WorkbookDraft[]
  readonly present: WorkbookDraft
  readonly future: readonly WorkbookDraft[]
}

/** How many changes undo reaches back. */
const HISTORY_LIMIT = 200

export function startHistory(workbook: Workbook): DraftHistory {
  return { past: [], present: startDraft(workbook), future: [] }
}

/** The draft after a change, which undo returns from; one that changes nothing is not kept. */
export function recordDraft(history: DraftHistory, next: WorkbookDraft): DraftHistory {
  if (next === history.present) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
  }
}

export function undoDraft(history: DraftHistory): DraftHistory {
  const previous = history.past.at(-1)
  if (!previous) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  }
}

export function redoDraft(history: DraftHistory): DraftHistory {
  const next = history.future[0]
  if (!next) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  }
}

/** Whether a cell holds a value the draft changed: in a row it added, any value at all. */
export function cellEdited(row: readonly string[] | undefined, column: number): boolean {
  if (!row) return false
  const origin = ORIGINS.get(row)
  if (origin === undefined) return false
  return (origin?.[column] ?? "") !== (row[column] ?? "")
}

/**
 * The sheet as the grid draws it from the draft's table: its computed columns filled again, and
 * each column as wide as the version drew it and at its decimals, so a column doesn't change its
 * form as its values change.
 */
export function draftModel(sheet: WorkbookSheet, table: CsvTable, base: SheetModel): SheetModel {
  const model = sheetModel(sheet, table)
  const drawn = new Map(base.columns.map((column) => [column.name, column]))
  return {
    ...model,
    columns: model.columns.map((column) => {
      const before = drawn.get(column.name)
      return before ? { ...column, width: before.width, decimals: before.decimals } : column
    }),
  }
}

/** Whether the draft holds anything to save: a table that isn't the version's. */
export function draftChanged(draft: WorkbookDraft): boolean {
  return draft.tables.size > 0
}

/** The files a save publishes: each changed sheet's CSV, by its path in the artifact. */
export function draftFiles(draft: WorkbookDraft): Map<string, string> {
  const files = new Map<string, string>()
  for (const [sheet, table] of draft.tables) {
    files.set(sheetFilePath(sheet), formatCsv(table.header, table.rows))
  }
  return files
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
  return { header, rows }
}

function withTable(draft: WorkbookDraft, sheet: string, table: CsvTable): WorkbookDraft {
  const tables = new Map(draft.tables)
  tables.set(sheet, table)
  return { ...draft, tables }
}
