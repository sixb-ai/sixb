import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress } from "../../address"
import { CsvParseError, type CsvTable, parseCsv } from "../../csv"
import { evaluateComputedColumns } from "../../formula"
import { ARTIFACT_LIMITS } from "../../limits"
import { liveSheetColumns } from "../../live-sheet"
import type { SheetOutline } from "../../outline"
import { artifactQueryPath, type CheckedArtifactQuery } from "../../queries"
import { sheetChartsProblem, sheetColumnsProblem, sheetFormulasProblem } from "../../sheet-rules"
import type { ArtifactWarning } from "../../warnings"
import {
  parseSheetDate,
  parseSheetNumber,
  parseWorkbook,
  type SheetColumnFormat,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookSheet,
} from "../../workbook"
import { type ArtifactBlobStorage, invalidArtifact, readArtifactText } from "../files"
import type { FoundReference } from "../references"

/**
 * Reads a sheet: `workbook.json`, then each sheet's CSV against it. Every cell of a typed column
 * must read as its type, every formula must compute its column, and every chart must name columns
 * its sheet has, so the grid formats and the charts draw the same wherever the sheet is opened.
 * Rows a formula computes to an error are warnings: the version publishes, and the grid shows them.
 *
 * A live sheet is checked against `queries`, what checking the version's queries as its author
 * learned: its query returns rows, and its columns show properties those rows hold, so its rules
 * hold as a CSV sheet's do. Its rows are each reader's, so no cell is checked.
 */
export async function validateSheet(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[],
  queries: ReadonlyMap<string, CheckedArtifactQuery>
): Promise<{
  readonly entry: string
  readonly outline: SheetOutline
  readonly references: readonly FoundReference[]
  readonly warnings: readonly ArtifactWarning[]
}> {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const workbookFile = byPath.get(WORKBOOK_FILE)
  if (!workbookFile) {
    throw invalidArtifact(
      `A sheet is a directory: '${WORKBOOK_FILE}' listing its sheets, and one CSV per sheet under sheets/. A single CSV publishes as a file.`
    )
  }
  const parsed = parseWorkbook(
    await readArtifactText(blobStorage, workbookFile, ARTIFACT_LIMITS.maxWorkbookBytes)
  )
  if ("error" in parsed) throw invalidArtifact(parsed.error)
  const { workbook } = parsed

  const declared = new Set(workbook.sheets.map((sheet) => sheetFilePath(sheet.name)))
  const stray = files.find((file) => file.path.startsWith("sheets/") && !declared.has(file.path))
  if (stray) {
    throw invalidArtifact(
      `'${stray.path}' is not a sheet in ${WORKBOOK_FILE}: list it in "sheets", or move it out of sheets/.`
    )
  }

  const tables = new Map<string, CsvTable>()
  const references: FoundReference[] = []
  const warnings: ArtifactWarning[] = []
  const sheets: WorkbookSheet[] = []
  for (const sheet of workbook.sheets) {
    if (sheet.live) {
      const live = liveSheet(byPath, sheet, queries.get(sheet.live.query))
      sheets.push(live.sheet)
      tables.set(sheet.name, live.table)
      continue
    }

    const table = await readSheet(blobStorage, byPath, sheet, references)
    sheets.push(sheet)
    tables.set(sheet.name, table)
    warnings.push(...computeSheet(sheet, table))
  }

  // A live sheet's charts plot the columns it lays out, typed as its query's rows are.
  const laidOut: Workbook = { ...workbook, sheets }
  const charts = sheetChartsProblem(laidOut, tables)
  if (charts) throw invalidArtifact(charts)

  return {
    entry: WORKBOOK_FILE,
    outline: {
      kind: "sheet",
      sheets: workbook.sheets.map((sheet) => {
        const table = tables.get(sheet.name)
        return {
          name: sheet.name,
          rows: table?.rows.length ?? 0,
          columns: [...(table?.header ?? [])],
          ...(sheet.live ? { query: sheet.live.query } : {}),
        }
      }),
      charts: workbook.charts.map((chart) => chart.name),
    },
    references,
    warnings,
  }
}

/**
 * A live sheet laid out against its query as the author reads it, and its header as the table a
 * CSV would hold, with no rows: the rules a CSV sheet keeps are checked on it.
 */
function liveSheet(
  byPath: ReadonlyMap<string, ArtifactFile>,
  sheet: WorkbookSheet,
  checked: CheckedArtifactQuery | undefined
): { readonly sheet: WorkbookSheet; readonly table: CsvTable } {
  const query = sheet.live?.query
  const csv = sheetFilePath(sheet.name)
  if (byPath.has(csv)) {
    throw invalidArtifact(
      `Sheet '${sheet.name}' reads its rows from query '${query}', so it has no '${csv}': remove the CSV, or "query" to show it.`
    )
  }

  if (!checked || query === undefined) {
    throw invalidArtifact(
      `Sheet '${sheet.name}' reads query '${query}', which the version does not have: add '${artifactQueryPath(query ?? "")}'.`
    )
  }
  if (checked.kind === "facets") {
    throw invalidArtifact(
      `Sheet '${sheet.name}' reads query '${query}', which counts facets: a sheet shows rows. A page shows facets; give the sheet a query of rows.`
    )
  }

  const layout = liveSheetColumns(sheet, checked.schema)
  if (layout.problem) throw invalidArtifact(layout.problem)

  const table = { header: layout.columns.map((column) => column.name), rows: [] }
  const problem =
    sheetColumnsProblem(layout.sheet, table) ?? sheetFormulasProblem(layout.sheet, table)
  if (problem) throw invalidArtifact(problem)

  return { sheet: layout.sheet, table }
}

async function readSheet(
  blobStorage: ArtifactBlobStorage,
  byPath: ReadonlyMap<string, ArtifactFile>,
  sheet: WorkbookSheet,
  references: FoundReference[]
): Promise<CsvTable> {
  const path = sheetFilePath(sheet.name)
  const file = byPath.get(path)
  if (!file) throw invalidArtifact(`Sheet '${sheet.name}' needs its values in '${path}'.`)

  if (file.file.sizeBytes > ARTIFACT_LIMITS.maxSheetFileBytes) {
    throw invalidArtifact(
      `'${path}' is ${megabytes(file.file.sizeBytes)} MB; a sheet's values may be at most ${megabytes(ARTIFACT_LIMITS.maxSheetFileBytes)} MB, which is what the viewer reads. Split it into several sheets, or publish the CSV as a file.`
    )
  }
  let table: CsvTable
  try {
    table = parseCsv(await readArtifactText(blobStorage, file, ARTIFACT_LIMITS.maxSheetFileBytes))
  } catch (error) {
    if (error instanceof CsvParseError) throw invalidArtifact(`'${path}': ${error.message}`)
    throw error
  }

  const columns = sheetColumnsProblem(sheet, table)
  if (columns) throw invalidArtifact(columns)

  const { header } = table
  for (const [column, format] of Object.entries(sheet.columns)) {
    const index = header.indexOf(column)
    if (format.type === "link" || format.type === "image") {
      // A link or image may be another artifact's address, resolved with the rest.
      for (const [rowIndex, row] of table.rows.entries()) {
        const value = row[index]?.trim() ?? ""
        if (!isArtifactAddress(value)) continue
        references.push({
          address: value,
          as: format.type === "image" ? "embed" : "link",
          at: `${sheet.name}!${columnLetter(index)}${rowIndex + 2}`,
        })
      }
    }
    if (format.formula) {
      checkComputedValues(path, table, index, column)
      continue
    }
    checkColumn(path, table, index, column, format, byPath)
  }
  return table
}

/** A computed column's values come from its formula: the CSV leaves them empty. */
function checkComputedValues(path: string, table: CsvTable, index: number, column: string): void {
  for (const [rowIndex, row] of table.rows.entries()) {
    const value = row[index] ?? ""
    if (value.trim()) {
      throw invalidArtifact(
        `'${path}' row ${rowIndex + 2}, column '${column}': ${JSON.stringify(value)} is in a computed column; leave its values empty, and its formula fills them.`
      )
    }
  }
}

/**
 * Checks each computed column's formula against the sheet's columns and computes them all, so a
 * formula that can't compute refuses the version and one that computes to an error in some rows
 * warns.
 */
function computeSheet(sheet: WorkbookSheet, table: CsvTable): ArtifactWarning[] {
  const formulas = sheetFormulasProblem(sheet, table)
  if (formulas) throw invalidArtifact(formulas)

  const computed = evaluateComputedColumns(sheet, table)
  return [...computed.errors].map(([column, errors]) => ({
    code: "sheet_formula_error",
    part: sheet.name,
    message: `Sheet '${sheet.name}' column '${column}' computes to ${errors.code} in ${errors.count === 1 ? "1 row" : `${errors.count} rows`}, the first row ${errors.firstRow + 2}. IFERROR gives those rows a value.`,
  }))
}

function checkColumn(
  path: string,
  table: CsvTable,
  index: number,
  column: string,
  format: SheetColumnFormat,
  byPath: ReadonlyMap<string, ArtifactFile>
): void {
  for (const [rowIndex, row] of table.rows.entries()) {
    const value = row[index] ?? ""
    if (!value.trim() || isArtifactAddress(value)) continue
    const problem = cellProblem(value, format, byPath)
    if (problem) {
      throw invalidArtifact(
        `'${path}' row ${rowIndex + 2}, column '${column}': ${JSON.stringify(value)} ${problem}`
      )
    }
  }
}

function cellProblem(
  value: string,
  format: SheetColumnFormat,
  byPath: ReadonlyMap<string, ArtifactFile>
): string | undefined {
  switch (format.type) {
    case "number":
    case "currency":
      return parseSheetNumber(value) === undefined
        ? "is not a number: write plain digits, such as 4120000 or -3.5, with no symbols or separators."
        : undefined
    case "percent":
      return parseSheetNumber(value) === undefined
        ? "is not a number: write a percent as a fraction, such as 0.351 for 35.1%."
        : undefined
    case "date":
      return parseSheetDate(value) === undefined
        ? "is not a date: write YYYY-MM-DD, or an ISO 8601 date and time."
        : undefined
    case "link":
      return /^https?:\/\/[^\s]+$/i.test(value.trim())
        ? undefined
        : "is not a link: write a full https:// address, or another artifact's address."
    case "image": {
      const imagePath = posix.normalize(value.trim())
      return byPath.has(imagePath)
        ? undefined
        : "is not one of the artifact's files: add the image to the artifact and give its relative path, or give another artifact's address."
    }
    case "boolean":
      return /^(true|false)$/i.test(value.trim())
        ? undefined
        : "is not true or false: write true or false, or leave the cell empty."
    case "text":
    case "tag":
      return undefined
  }
}

/** A column's letter as a spreadsheet shows it: A, Z, AA. */
function columnLetter(index: number): string {
  let letters = ""
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  }
  return letters
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")
}
