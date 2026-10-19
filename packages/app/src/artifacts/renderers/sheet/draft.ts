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

/** Stores values in a sheet's cells. A value the cell already holds changes nothing. */
export function setCells(
  draft: WorkbookDraft,
  sheet: string,
  base: CsvTable,
  edits: readonly CellEdit[]
): WorkbookDraft {
  const table = draftTable(draft, sheet, base)
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
  if (changed.size === 0) return draft
  const rows = table.rows.map((row, index) => changed.get(index) ?? row)
  return withTable(draft, sheet, { header: table.header, rows })
}

/** Whether a cell holds a value the draft changed, or is in a row the draft added. */
export function cellEdited(row: readonly string[] | undefined, column: number): boolean {
  if (!row) return false
  const origin = ORIGINS.get(row)
  if (origin === undefined) return false
  return origin === null || (origin[column] ?? "") !== (row[column] ?? "")
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

/** Whether the draft holds anything to save. */
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

function withTable(draft: WorkbookDraft, sheet: string, table: CsvTable): WorkbookDraft {
  const tables = new Map(draft.tables)
  tables.set(sheet, table)
  return { ...draft, tables }
}
