/**
 * What a client needs to show an artifact the way publishing read it: the kinds, the slugs its
 * headings get, its theme, a sheet's workbook and CSV, and the `artifact:` addresses that point
 * into it. Browser-safe: no storage, no Bun APIs.
 */

export {
  type ArtifactAddress,
  type CellRange,
  formatArtifactAddress,
  isArtifactAddress,
  parseArtifactAddress,
  parseSheetPart,
  type SheetPart,
} from "./address"
export { CsvParseError, type CsvTable, parseCsv } from "./csv"
export {
  DECK_KEYS,
  type DeckMode,
  FRAME_PROTOCOL,
  FRAME_THEME_TOKENS,
  type FrameEvent,
  type FrameRequest,
  type FrameResponse,
  type FrameStart,
  frameStartHash,
} from "./frames/protocol"
export { ARTIFACT_KINDS } from "./kinds"
export { createHeadingSlugger } from "./outline"
export {
  type ArtifactAddressTarget,
  type ResolvedArtifactPart,
  resolveArtifactAddress,
} from "./resolve"
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
