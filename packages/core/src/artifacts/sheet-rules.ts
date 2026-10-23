import type { CsvTable } from "./csv"
import {
  checkFormula,
  columnFormulaType,
  evaluateComputedColumns,
  FormulaCycleError,
  FormulaSyntaxError,
  formulaFitsColumn,
  parseFormula,
} from "./formula"
import { ARTIFACT_LIMITS } from "./limits"
import {
  NUMERIC_COLUMN_TYPES,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookSheet,
} from "./workbook"

/**
 * Whether a sheet's workbook and tables keep the rules publishing holds them to, whatever their
 * cells hold: columns named once, every column the workbook names in its table, formulas that
 * compute their columns, and charts that plot what they can draw. Returns the first rule broken,
 * in the words publishing refuses the version with, or null. A sheet without a table here is not
 * checked, nor a chart on it, so an editor can check only the sheet it changed.
 */
export function checkSheet(
  workbook: Workbook,
  tables: ReadonlyMap<string, CsvTable>
): string | null {
  for (const sheet of workbook.sheets) {
    const table = tables.get(sheet.name)
    if (!table) continue

    const problem = sheetColumnsProblem(sheet, table) ?? sheetFormulasProblem(sheet, table)
    if (problem) return problem
  }

  return sheetChartsProblem(workbook, tables)
}

/**
 * A table's header and size against its sheet: named, unique, and holding what the sheet names. A
 * live sheet's header is the columns its workbook lists.
 */
export function sheetColumnsProblem(sheet: WorkbookSheet, table: CsvTable): string | null {
  const path = sheetFilePath(sheet.name)
  const source = sheet.live ? `${WORKBOOK_FILE} sheet '${sheet.name}' "columns"` : `'${path}'`
  const { header, rows } = table

  if (header.length === 0) return `'${path}' is empty: its first line names the columns.`
  if (header.length > ARTIFACT_LIMITS.maxSheetColumns) {
    return `${source} has ${header.length} columns; a sheet holds at most ${ARTIFACT_LIMITS.maxSheetColumns}.`
  }

  const seen = new Set<string>()
  for (const [index, name] of header.entries()) {
    if (!name.trim())
      return `${source} column ${index + 1} has no name${sheet.live ? "" : " in the header row"}.`
    if (seen.has(name)) return `${source} has two columns named '${name}'.`
    seen.add(name)
  }

  if (rows.length > ARTIFACT_LIMITS.maxSheetRows) {
    return `'${path}' has ${rows.length} rows; a sheet holds at most ${ARTIFACT_LIMITS.maxSheetRows}.`
  }
  for (const [index, row] of rows.entries()) {
    if (row.length > header.length) {
      return `'${path}' row ${index + 2} has ${row.length} fields; the header names ${header.length} columns.`
    }
  }

  for (const column of [
    ...Object.keys(sheet.columns),
    ...Object.keys(sheet.widths),
    ...Object.keys(sheet.descriptions),
    ...Object.keys(sheet.totals),
  ]) {
    if (!seen.has(column)) {
      return `${WORKBOOK_FILE} sheet '${sheet.name}' names column '${column}', which ${sheet.live ? 'its "columns" does not list' : `'${path}' does not have`}.`
    }
  }

  return null
}

/**
 * Each computed column's formula against the columns it reads: it reads, its result fits the
 * column, and no columns compute from each other.
 */
export function sheetFormulasProblem(sheet: WorkbookSheet, table: CsvTable): string | null {
  const at = (column: string) => `${WORKBOOK_FILE} sheet '${sheet.name}' column '${column}'`
  const types = new Map(
    table.header.map((name) => [name, columnFormulaType(sheet.columns[name]?.type ?? "text")])
  )

  for (const [column, format] of Object.entries(sheet.columns)) {
    if (!format.formula) continue

    let node: ReturnType<typeof parseFormula>
    try {
      node = parseFormula(format.formula)
    } catch (error) {
      if (error instanceof FormulaSyntaxError) {
        return `${at(column)} "formula" does not read: ${error.message}`
      }
      throw error
    }

    const checked = checkFormula(node, types)
    if ("error" in checked) return `${at(column)} "formula": ${checked.error}.`
    if (!formulaFitsColumn(checked.type, format.type)) {
      return `${at(column)} "formula" computes ${checked.type === "date" ? "a date" : checked.type === "boolean" ? "true or false" : checked.type === "text" ? "text" : "a number"}, which a ${format.type} column can't show: change its type, or the formula.`
    }
  }

  // Over no rows, the columns only find the order they compute in: a ring of them throws.
  try {
    evaluateComputedColumns(sheet, { header: table.header, rows: [] })
  } catch (error) {
    if (error instanceof FormulaCycleError) {
      return `${WORKBOOK_FILE} sheet '${sheet.name}': ${error.message}, so none can be computed first.`
    }
    throw error
  }

  return null
}

/**
 * Each chart against its sheet: the columns it plots exist and are numbers, its right axis reads
 * one kind, and a pie has few enough slices to tell apart.
 */
export function sheetChartsProblem(
  workbook: Workbook,
  tables: ReadonlyMap<string, CsvTable>
): string | null {
  for (const chart of workbook.charts) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === chart.sheet)
    const table = tables.get(chart.sheet)
    if (!sheet || !table) continue

    const plotted = [...chart.y, ...chart.line]
    for (const column of [chart.x, ...plotted]) {
      if (!table.header.includes(column)) {
        return `${WORKBOOK_FILE} chart '${chart.name}' plots column '${column}', which sheet '${chart.sheet}' does not have.`
      }
    }

    // A scatter places each row by its x, so x is a number too.
    for (const column of chart.type === "scatter" ? [chart.x, ...plotted] : plotted) {
      const type = sheet.columns[column]?.type ?? "text"
      if (!NUMERIC_COLUMN_TYPES.includes(type)) {
        return `${WORKBOOK_FILE} chart '${chart.name}' plots column '${column}', which is ${type}; give it a number, currency, or percent type in "columns".`
      }
    }

    // Lines of another kind than the bars read on one right axis, which reads one kind.
    const barType = sheet.columns[chart.y[0] ?? ""]?.type
    const rightTypes = new Set(
      chart.line.map((column) => sheet.columns[column]?.type).filter((type) => type !== barType)
    )
    if (rightTypes.size > 1) {
      return `${WORKBOOK_FILE} chart '${chart.name}' draws lines of ${[...rightTypes].join(" and ")} over ${barType ?? "its"} bars; the right axis reads one kind. Chart the others separately.`
    }

    if (chart.type === "pie") {
      // A pie's slices are its rows, or its x values when it summarizes them.
      const index = table.header.indexOf(chart.x)
      const slices = chart.aggregate
        ? new Set(table.rows.map((row) => (row[index] ?? "").trim())).size
        : table.rows.length
      if (slices > ARTIFACT_LIMITS.maxPieSlices) {
        return `${WORKBOOK_FILE} chart '${chart.name}' is a pie with ${slices} slices; a pie reads well with at most ${ARTIFACT_LIMITS.maxPieSlices}. Use a bar chart instead.`
      }
    }
  }

  return null
}
