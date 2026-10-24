import { formulaReferences, parseFormula } from "@sixb/core/artifacts"
import type { ArtifactMessages } from "../../messages"
import { isLocked, lockedColumns, type SheetModel } from "./model"

/**
 * What locks a live sheet's values, in the words a reader can act on. A property the reader is not
 * cleared for is a permission they can ask for; a computed column has none of its own, so what
 * locks it is the properties its formula reads, through as many computed columns as it reads.
 */

/** Each column's formula references, by column index: none for a column that is not computed. */
const REFERENCES = new WeakMap<SheetModel, readonly (ColumnReferences | null)[]>()

interface ColumnReferences {
  readonly row: readonly number[]
  readonly whole: readonly number[]
}

function references(model: SheetModel): readonly (ColumnReferences | null)[] {
  const cached = REFERENCES.get(model)
  if (cached) return cached

  const indexOf = new Map(model.columns.map((column, index) => [column.name, index]))
  const indexes = (names: ReadonlySet<string>) =>
    [...names].map((name) => indexOf.get(name)).filter((index) => index !== undefined)

  const read = model.columns.map((column) => {
    if (!column.format.formula) return null
    const { row, whole } = formulaReferences(parseFormula(column.format.formula))
    return { row: indexes(row), whole: indexes(whole) }
  })
  REFERENCES.set(model, read)
  return read
}

/**
 * The properties that lock a column's values, by name in the sheet's order: the column itself when
 * it shows one, else the locked ones its formula reads. With `row`, only what locks that row's cell:
 * a value of the row, or of a column the formula reads whole.
 */
export function lockedBy(model: SheetModel, column: number, row?: number): string[] {
  const read = references(model)
  const anywhere = new Set(
    lockedColumns(model).map((name) => model.columns.findIndex((entry) => entry.name === name))
  )

  const sources = new Set<number>()
  const seen = new Set<string>()
  const visit = (index: number, at: number | undefined) => {
    const key = `${index}:${at ?? "*"}`
    if (seen.has(key)) return
    seen.add(key)

    const formula = read[index]
    if (!formula) {
      const locked = at === undefined ? anywhere.has(index) : isLocked(model, at, index)
      if (locked) sources.add(index)
      return
    }

    for (const each of formula.row) visit(each, at)
    for (const each of formula.whole) visit(each, undefined)
  }
  visit(column, row)

  return model.columns.flatMap((entry, index) => (sources.has(index) ? [entry.name] : []))
}

/** The properties that lock any of these columns, by name in the sheet's order. */
export function lockedByAny(model: SheetModel, columns: readonly string[]): string[] {
  const names = new Set(
    columns.flatMap((name) => {
      const index = model.columns.findIndex((entry) => entry.name === name)
      return index < 0 ? [] : lockedBy(model, index)
    })
  )
  return model.columns.flatMap((entry) => (names.has(entry.name) ? [entry.name] : []))
}

/** The properties whose values the reader may not see somewhere in the sheet, never a computed column. */
export function hiddenProperties(model: SheetModel): string[] {
  return lockedColumns(model).filter(
    (name) => !model.columns.find((entry) => entry.name === name)?.format.formula
  )
}

/** Why a data row's locked cell is locked: the permission it lacks, or what it is computed from. */
export function lockedCellLabel(
  model: SheetModel,
  row: number,
  column: number,
  messages: ArtifactMessages["sheet"]
): string {
  const name = model.columns[column]?.name ?? ""
  const sources = lockedBy(model, column, row)
  return model.columns[column]?.format.formula && sources.length > 0
    ? messages.lockedComputed(name, sources)
    : messages.locked(name)
}

/** Why a column's total is locked: a permission it lacks, or what the column is computed from. */
export function lockedTotalLabel(
  model: SheetModel,
  column: number,
  messages: ArtifactMessages["sheet"]
): string {
  const name = model.columns[column]?.name ?? ""
  const sources = lockedBy(model, column)
  return model.columns[column]?.format.formula && sources.length > 0
    ? messages.lockedTotalComputed(name, sources)
    : messages.lockedTotal(name)
}
