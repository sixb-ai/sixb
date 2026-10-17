/**
 * What a client needs to show an artifact the way publishing read it: the kinds, the slugs its
 * headings get, its theme, and a sheet's workbook and CSV. Browser-safe: no storage, no Bun APIs.
 */

export { CsvParseError, type CsvTable, parseCsv } from "./csv"
export { ARTIFACT_KINDS } from "./kinds"
export { createHeadingSlugger } from "./outline"
export { ARTIFACT_THEME_FILE, type ArtifactTheme, parseArtifactTheme } from "./theme"
export {
  NUMERIC_COLUMN_TYPES,
  parseSheetDate,
  parseSheetNumber,
  parseWorkbook,
  type SheetChartType,
  type SheetColumnFormat,
  type SheetColumnType,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookChart,
  type WorkbookSheet,
} from "./workbook"
