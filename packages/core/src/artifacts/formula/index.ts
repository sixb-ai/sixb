import type { CsvTable } from "../csv"
import {
  NUMERIC_COLUMN_TYPES,
  parseSheetDate,
  parseSheetNumber,
  type SheetColumnType,
  type WorkbookSheet,
} from "../workbook"
import type { FormulaType } from "./check"
import {
  dateSerial,
  evaluateFormula,
  type FormulaErrorCode,
  type FormulaValue,
  formulaText,
  serialDate,
} from "./evaluate"
import { type FormulaNode, formulaDependencies, parseFormula } from "./parser"

export {
  AGGREGATE_FUNCTIONS,
  checkFormula,
  FORMULA_FUNCTIONS,
  type FormulaType,
} from "./check"
export {
  FORMULA_ERRORS,
  type FormulaErrorCode,
  type FormulaValue,
} from "./evaluate"
export {
  type FormulaNode,
  type FormulaOperator,
  FormulaSyntaxError,
  formulaDependencies,
  parseFormula,
  renameColumnReferences,
} from "./parser"

/** What a column's values are, as a formula reads them. */
export function columnFormulaType(type: SheetColumnType): FormulaType {
  if (NUMERIC_COLUMN_TYPES.includes(type)) return "number"
  if (type === "date" || type === "boolean") return type
  return "text"
}

/**
 * Whether what a formula yields can fill a column of a type: numbers in a number, currency, or
 * percent column, dates in a date column, booleans in a boolean one, anything in text or a tag.
 * A value whose kind depends on the row fits anywhere, and is `#VALUE!` where it doesn't.
 */
export function formulaFitsColumn(result: FormulaType, type: SheetColumnType): boolean {
  if (result === "any" || type === "text" || type === "tag") return true
  if (NUMERIC_COLUMN_TYPES.includes(type)) return result === "number"
  if (type === "date") return result === "date"
  if (type === "boolean") return result === "boolean"
  return false
}

/** Computed columns that read each other in a ring, so none can be computed first. */
export class FormulaCycleError extends Error {
  constructor(readonly columns: readonly string[]) {
    super(`columns ${columns.map((column) => `'${column}'`).join(" → ")} compute from each other`)
    this.name = "FormulaCycleError"
  }
}

/** Where a computed column computes to an error: how many rows, and the first. */
export interface ComputedColumnErrors {
  readonly count: number
  /** The first row, as the data row's index from 0. */
  readonly firstRow: number
  readonly code: FormulaErrorCode
}

/**
 * A sheet's table with its computed columns filled in, each in an order that computes what it
 * reads first, its values written as the column's type stores them. Throws a
 * {@link FormulaCycleError} for columns that read each other; publishing has refused those, and
 * every formula that doesn't parse or check.
 */
export function evaluateComputedColumns(
  sheet: Pick<WorkbookSheet, "columns">,
  table: CsvTable
): { readonly table: CsvTable; readonly errors: ReadonlyMap<string, ComputedColumnErrors> } {
  const computed = table.header.filter((name) => sheet.columns[name]?.formula !== undefined)
  if (computed.length === 0) return { table, errors: new Map() }
  const formulas = new Map(
    computed.map((name) => [name, parseFormula(sheet.columns[name]?.formula ?? "")])
  )
  const indexOf = new Map(table.header.map((name, index) => [name, index]))
  const typeOf = (name: string) => sheet.columns[name]?.type ?? "text"

  // Each column's values as a formula reads them, read once and filled as columns compute.
  const values = new Map<string, FormulaValue[]>()
  const columnValues = (name: string): FormulaValue[] => {
    let column = values.get(name)
    if (!column) {
      const index = indexOf.get(name) ?? -1
      const type = typeOf(name)
      column = table.rows.map((row) => readCell(row[index] ?? "", type))
      values.set(name, column)
    }
    return column
  }

  const rows = table.rows.map((row) => {
    const copy = [...row]
    while (copy.length < table.header.length) copy.push("")
    return copy
  })
  const errors = new Map<string, ComputedColumnErrors>()
  for (const name of computeOrder(formulas)) {
    const formula = formulas.get(name) as FormulaNode
    const index = indexOf.get(name) as number
    const type = typeOf(name)
    const results: FormulaValue[] = []
    const memo = new Map<FormulaNode, FormulaValue>()
    for (const [rowIndex, row] of rows.entries()) {
      const result = evaluateFormula(
        formula,
        {
          cell: (column) => columnValues(column)[rowIndex] ?? null,
          column: (column) => columnValues(column),
        },
        memo
      )
      const cell = writeCell(result, type)
      results.push(typeof cell === "object" ? cell : result)
      row[index] = typeof cell === "object" ? cell.error : cell
      if (typeof cell === "object") {
        const known = errors.get(name)
        errors.set(name, {
          count: (known?.count ?? 0) + 1,
          firstRow: known?.firstRow ?? rowIndex,
          code: known?.code ?? cell.error,
        })
      }
    }
    values.set(name, results)
  }
  return { table: { header: table.header, rows }, errors }
}

/** The order to compute in: each column after those it reads. */
function computeOrder(formulas: ReadonlyMap<string, FormulaNode>): string[] {
  const order: string[] = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (name: string, path: string[]) => {
    if (state.get(name) === "done") return
    if (state.get(name) === "visiting") {
      throw new FormulaCycleError([...path.slice(path.indexOf(name)), name])
    }
    state.set(name, "visiting")
    for (const dependency of formulaDependencies(formulas.get(name) as FormulaNode)) {
      if (formulas.has(dependency)) visit(dependency, [...path, name])
    }
    state.set(name, "done")
    order.push(name)
  }
  for (const name of formulas.keys()) visit(name, [])
  return order
}

/** A stored cell as a formula reads it: a blank, its type's value, or its text as written. */
function readCell(raw: string, type: SheetColumnType): FormulaValue {
  if (!raw.trim()) return null
  if (NUMERIC_COLUMN_TYPES.includes(type)) return parseSheetNumber(raw) ?? raw
  if (type === "date") {
    const date = parseSheetDate(raw)
    return date ? dateSerial(date) : raw
  }
  if (type === "boolean") {
    const word = raw.trim().toLowerCase()
    return word === "true" ? true : word === "false" ? false : raw
  }
  return raw
}

/** A computed value as its column stores it, or the error it is where it doesn't fit. */
function writeCell(
  value: FormulaValue,
  type: SheetColumnType
): string | { readonly error: FormulaErrorCode } {
  if (typeof value === "object" && value !== null) return value
  if (value === null) return ""
  if (type === "text" || type === "tag") return formulaText(value)
  if (NUMERIC_COLUMN_TYPES.includes(type)) {
    return typeof value === "number" ? formulaText(value) : { error: "#VALUE!" }
  }
  if (type === "date") {
    return typeof value === "number" ? serialDate(value) : { error: "#VALUE!" }
  }
  if (type === "boolean") {
    return typeof value === "boolean" ? String(value) : { error: "#VALUE!" }
  }
  return { error: "#VALUE!" }
}
