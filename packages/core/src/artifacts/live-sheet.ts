import type { CsvTable } from "./csv"
import { formulaDependencies, parseFormula } from "./formula/parser"
import type { ArtifactQueryProperty, ArtifactQuerySchema } from "./queries"
import {
  NUMERIC_COLUMN_TYPES,
  readSheetColumnFormat,
  type SheetColumnFormat,
  type SheetColumnType,
  type SheetTotal,
  sheetTotalProblem,
  WORKBOOK_FILE,
  type WorkbookSheet,
} from "./workbook"

/**
 * A live sheet laid out against what its query's rows hold: publishing checks it as its author
 * sees the rows, and the viewer draws it as each reader does.
 */
export interface LiveSheetLayout {
  /**
   * The sheet with a format for every column, as a CSV sheet's workbook gives them: what the
   * publish rules, the grid and the charts read.
   */
  readonly sheet: WorkbookSheet
  /** Each column, in order, with what it shows. */
  readonly columns: readonly LiveSheetColumn[]
  /** The first column that does not lay out, in the words publishing refuses it with; or null. */
  readonly problem: string | null
}

export interface LiveSheetColumn {
  readonly name: string
  /** The property the column shows, of the rows or of what `linkId` reaches; none when computed. */
  readonly from?: { readonly linkId?: string; readonly propertyId: string }
  /** Whether the rows hold no such property for this reader: every cell of it is locked. */
  readonly missing: boolean
}

/** What a row of a query's result holds, as core reads it and as the API serializes it. */
export interface LiveSheetRow {
  readonly properties: Readonly<Record<string, unknown>>
  /** The properties left out because the reader is not cleared for them. */
  readonly redactions?: Readonly<Record<string, unknown>>
  readonly links?: Readonly<Record<string, LiveSheetRow | readonly LiveSheetRow[] | null>>
}

/** A live sheet's rows as a sheet's CSV would hold them, and the cells the reader may not see. */
export interface LiveSheetTable {
  /** Each cell as a CSV cell holds its value, computed columns empty. */
  readonly table: CsvTable
  /**
   * By row, the columns of the cells the reader may not see: drawn locked, never as empty. A
   * computed cell that reads a locked one is locked too.
   */
  readonly locked: ReadonlyMap<number, ReadonlySet<number>>
}

/**
 * The column type a property's values take in a sheet: numbers, dates, true or false, an enum's
 * values as tags, and anything else as text. The ontology names no money or ratio, so a number is
 * a number; a column that wants a currency says so.
 */
export function sheetColumnType(property: ArtifactQueryProperty): SheetColumnType {
  switch (property.type) {
    case "integer":
    case "double":
    case "decimal":
      return "number"
    case "boolean":
      return "boolean"
    case "date":
    case "timestamp":
      return "date"
    case "enum":
      return property.valueType === "integer" ? "number" : "tag"
    default:
      return "text"
  }
}

/**
 * Lays a live sheet out against its query's schema: each column's property, and its type, its
 * property's unless the workbook gives one. A column whose property the schema lacks shows locked
 * cells, and `problem` names the first that does not lay out.
 */
export function liveSheetColumns(
  sheet: WorkbookSheet,
  schema: ArtifactQuerySchema
): LiveSheetLayout {
  const live = sheet.live
  if (!live) throw new Error(`[Sixb] Sheet '${sheet.name}' is not a live sheet.`)

  let problem: string | null = null
  const formats: Record<string, SheetColumnFormat> = {}
  const totals: Record<string, SheetTotal> = { ...sheet.totals }

  const columns = live.columns.map((source): LiveSheetColumn => {
    const columnAt = `sheet '${sheet.name}' column '${source.name}'`
    const at = `${WORKBOOK_FILE} ${columnAt}`
    const written = sheet.columns[source.name]

    if (source.from === undefined) {
      if (written) formats[source.name] = written
      return { name: source.name, missing: false }
    }

    const [first = "", second] = source.from.split(".")
    const from =
      second === undefined ? { propertyId: first } : { linkId: first, propertyId: second }
    const found = resolveProperty(schema, live.query, from)
    if ("problem" in found) problem ??= `${at} "from": ${found.problem}`

    const inferred = "property" in found ? sheetColumnType(found.property) : undefined
    const format = layColumn(columnAt, source.from, written, source.untyped, inferred)
    if (format.problem) problem ??= format.problem
    formats[source.name] = format.format

    const total = totals[source.name]
    const totalProblem =
      total && source.untyped
        ? sheetTotalProblem(
            `${WORKBOOK_FILE} sheet '${sheet.name}'`,
            source.name,
            total,
            format.format.type
          )
        : null
    if (totalProblem) {
      problem ??= totalProblem
      delete totals[source.name]
    }

    return { name: source.name, from, missing: !("property" in found) }
  })

  return { sheet: { ...sheet, columns: formats, totals }, columns, problem }
}

function resolveProperty(
  schema: ArtifactQuerySchema,
  query: string,
  from: NonNullable<LiveSheetColumn["from"]>
): { readonly property: ArtifactQueryProperty } | { readonly problem: string } {
  const { linkId, propertyId } = from

  if (linkId === undefined) {
    const property = schema.properties[propertyId]
    return property
      ? { property }
      : {
          problem: `query '${query}' returns no property '${propertyId}'${known(schema.properties)}.`,
        }
  }

  const link = schema.links[linkId]
  if (!link) {
    return {
      problem: `query '${query}' does not expand link '${linkId}': add it to the query's "expand" node, or show a property of the rows.`,
    }
  }

  const property = link.properties[propertyId]
  return property
    ? { property }
    : { problem: `link '${linkId}' reaches no property '${propertyId}'${known(link.properties)}.` }
}

function known(properties: Readonly<Record<string, unknown>>): string {
  const ids = Object.keys(properties)
  return ids.length > 0 ? `; it has ${ids.join(", ")}` : ""
}

/** A column's format: the one the workbook gives, checked against its property, or its property's. */
function layColumn(
  columnAt: string,
  from: string,
  written: SheetColumnFormat | undefined,
  untyped: Readonly<Record<string, unknown>> | undefined,
  inferred: SheetColumnType | undefined
): { readonly format: SheetColumnFormat; readonly problem?: string } {
  if (written) {
    if (inferred === undefined || fits(written.type, inferred)) return { format: written }
    return {
      format: written,
      problem: `${WORKBOOK_FILE} ${columnAt} is ${written.type}, but '${from}' holds ${HOLDS[inferred]}: leave out "type" to show it as its property is, or show another property.`,
    }
  }

  const type = inferred ?? "text"
  const read = readSheetColumnFormat(untyped ?? {}, columnAt, type)
  return "format" in read ? read : { format: { type }, problem: read.error }
}

const HOLDS: Readonly<Record<SheetColumnType, string>> = {
  text: "text",
  tag: "text",
  number: "numbers",
  currency: "numbers",
  percent: "numbers",
  date: "dates",
  boolean: "true or false",
  link: "text",
  image: "text",
}

/** Whether a column of `type` reads every value of a property whose own type is `inferred`. */
function fits(type: SheetColumnType, inferred: SheetColumnType): boolean {
  if (NUMERIC_COLUMN_TYPES.includes(type)) return inferred === "number"
  if (type === "date" || type === "boolean") return inferred === type
  return true
}

/**
 * A query's rows as a live sheet shows them: each column's value written as a CSV cell holds it,
 * so the grid, the charts and the downloads read them as they read a CSV sheet's. A value the
 * reader is not cleared for is a locked cell, as is every cell of a column the reader's rows do
 * not hold.
 */
export function liveSheetTable(
  layout: LiveSheetLayout,
  rows: readonly LiveSheetRow[]
): LiveSheetTable {
  const { columns } = layout
  const locked = new Map<number, Set<number>>()
  const lock = (row: number, column: number) => {
    const cells = locked.get(row) ?? new Set<number>()
    cells.add(column)
    locked.set(row, cells)
  }

  const tableRows = rows.map((row, rowIndex) =>
    columns.map((column, columnIndex) => {
      if (!column.from) return ""
      if (column.missing) {
        lock(rowIndex, columnIndex)
        return ""
      }

      const cell = readCell(row, column.from)
      if (cell.locked) lock(rowIndex, columnIndex)
      return cell.locked ? "" : cell.text
    })
  )

  lockComputed(layout, locked)
  return { table: { header: columns.map((column) => column.name), rows: tableRows }, locked }
}

function readCell(
  row: LiveSheetRow,
  from: NonNullable<LiveSheetColumn["from"]>
): { readonly text: string; readonly locked: boolean } {
  const { linkId, propertyId } = from
  if (linkId === undefined) return propertyCell(row, propertyId)

  const linked = row.links?.[linkId]
  if (!linked) return { text: "", locked: false }
  if (!isRowList(linked)) return propertyCell(linked, propertyId)

  // A link that reaches several objects shows each one's value; one the reader may not see locks it.
  const values = linked.map((each) => propertyCell(each, propertyId))
  return {
    text: values
      .map((value) => value.text)
      .filter(Boolean)
      .join(", "),
    locked: values.some((value) => value.locked),
  }
}

function isRowList(
  value: LiveSheetRow | readonly LiveSheetRow[]
): value is readonly LiveSheetRow[] {
  return Array.isArray(value)
}

function propertyCell(row: LiveSheetRow, propertyId: string) {
  if (row.redactions && Object.hasOwn(row.redactions, propertyId)) {
    return { text: "", locked: true }
  }
  return { text: cellText(row.properties[propertyId]), locked: false }
}

/** A value as a CSV cell holds it, which `parseSheetNumber` and `parseSheetDate` read back. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "bigint") return String(value)
  if (typeof value === "boolean") return value ? "true" : "false"
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(", ")
  return JSON.stringify(value)
}

/**
 * Locks each computed cell that reads a locked one, through as many computed columns as read each
 * other: a formula over a value the reader may not see would show what it computes without it.
 */
function lockComputed(layout: LiveSheetLayout, locked: Map<number, Set<number>>): void {
  const indexOf = new Map(layout.columns.map((column, index) => [column.name, index]))
  const computed = layout.columns.flatMap((column, index) => {
    const formula = column.from ? undefined : layout.sheet.columns[column.name]?.formula
    if (!formula) return []

    const reads = [...formulaDependencies(parseFormula(formula))]
      .map((name) => indexOf.get(name))
      .filter((read) => read !== undefined)
    return [{ index, reads }]
  })
  if (computed.length === 0) return

  for (const cells of locked.values()) {
    for (let changed = true; changed; ) {
      changed = false
      for (const { index, reads } of computed) {
        if (cells.has(index) || !reads.some((read) => cells.has(read))) continue
        cells.add(index)
        changed = true
      }
    }
  }
}
