/**
 * What a client needs to show an artifact the way publishing read it: the kinds and what each
 * holds, the slugs its headings get, its theme, a sheet's workbook and CSV, the limits a version
 * keeps within, the `artifact:` addresses that point into it, and the messages a viewer and a
 * deck's frame exchange, versioned as `sixb-frame/1`. Browser-safe: no storage, no Bun APIs.
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
  type DeckMode,
  FRAME_PROTOCOL,
  FRAME_THEME_TOKENS,
  type FrameEmbed,
  type FrameEvent,
  type FrameRequest,
  type FrameResponse,
  type FrameStart,
  frameStartHash,
  parseFrameEvent,
} from "./frames/protocol"
export { ARTIFACT_KINDS, type ArtifactKind } from "./kinds"
export { ARTIFACT_LIMITS } from "./limits"
export {
  type ArtifactOutline,
  createHeadingSlugger,
  type DocumentHeading,
  type DocumentOutline,
  type FileOutline,
  type SheetOutline,
  type SheetSummary,
  type SlidesOutline,
} from "./outline"
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
