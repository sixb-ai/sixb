import { posix } from "node:path"
import type { ArtifactFile } from "../../../storage/artifacts/types"
import { isArtifactAddress } from "../../address"
import { CsvParseError, type CsvTable, parseCsv } from "../../csv"
import { ARTIFACT_LIMITS } from "../../limits"
import type { SheetOutline } from "../../outline"
import {
  NUMERIC_COLUMN_TYPES,
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
 * must read as its type and every chart must name columns its sheet has, so the grid formats and
 * the charts draw the same wherever the sheet is opened.
 */
export async function validateSheet(
  blobStorage: ArtifactBlobStorage,
  files: readonly ArtifactFile[]
): Promise<{
  readonly entry: string
  readonly outline: SheetOutline
  readonly references: readonly FoundReference[]
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
  for (const sheet of workbook.sheets) {
    tables.set(sheet.name, await readSheet(blobStorage, byPath, sheet, references))
  }
  checkCharts(workbook, tables)

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
        }
      }),
      charts: workbook.charts.map((chart) => chart.name),
    },
    references,
  }
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

  const { header, rows } = table
  if (header.length === 0)
    throw invalidArtifact(`'${path}' is empty: its first line names the columns.`)
  if (header.length > ARTIFACT_LIMITS.maxSheetColumns) {
    throw invalidArtifact(
      `'${path}' has ${header.length} columns; a sheet holds at most ${ARTIFACT_LIMITS.maxSheetColumns}.`
    )
  }
  const seen = new Set<string>()
  for (const [index, name] of header.entries()) {
    if (!name.trim()) {
      throw invalidArtifact(`'${path}' column ${index + 1} has no name in the header row.`)
    }
    if (seen.has(name)) throw invalidArtifact(`'${path}' has two columns named '${name}'.`)
    seen.add(name)
  }
  if (rows.length > ARTIFACT_LIMITS.maxSheetRows) {
    throw invalidArtifact(
      `'${path}' has ${rows.length} rows; a sheet holds at most ${ARTIFACT_LIMITS.maxSheetRows}.`
    )
  }
  for (const [index, row] of rows.entries()) {
    if (row.length > header.length) {
      throw invalidArtifact(
        `'${path}' row ${index + 2} has ${row.length} fields; the header names ${header.length} columns.`
      )
    }
  }

  for (const column of [...Object.keys(sheet.columns), ...Object.keys(sheet.widths)]) {
    if (!seen.has(column)) {
      throw invalidArtifact(
        `${WORKBOOK_FILE} sheet '${sheet.name}' names column '${column}', which '${path}' does not have.`
      )
    }
  }
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
    checkColumn(path, table, index, column, format, byPath)
  }
  return table
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
    case "text":
      return undefined
  }
}

function checkCharts(workbook: Workbook, tables: ReadonlyMap<string, CsvTable>): void {
  for (const chart of workbook.charts) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === chart.sheet)
    const table = tables.get(chart.sheet)
    if (!sheet || !table) continue
    for (const column of [chart.x, ...chart.y]) {
      if (!table.header.includes(column)) {
        throw invalidArtifact(
          `${WORKBOOK_FILE} chart '${chart.name}' plots column '${column}', which sheet '${chart.sheet}' does not have.`
        )
      }
    }
    for (const column of chart.y) {
      const type = sheet.columns[column]?.type ?? "text"
      if (!NUMERIC_COLUMN_TYPES.includes(type)) {
        throw invalidArtifact(
          `${WORKBOOK_FILE} chart '${chart.name}' plots column '${column}', which is ${type}; give it a number, currency, or percent type in "columns".`
        )
      }
    }
    if (chart.type === "pie" && table.rows.length > ARTIFACT_LIMITS.maxPieSlices) {
      throw invalidArtifact(
        `${WORKBOOK_FILE} chart '${chart.name}' is a pie with ${table.rows.length} slices; a pie reads well with at most ${ARTIFACT_LIMITS.maxPieSlices}. Use a bar chart instead.`
      )
    }
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
