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
export {
  CANVAS_FILE,
  type Canvas,
  type CanvasArrow,
  type CanvasBoard,
  type CanvasEmbed,
  type CanvasEnd,
  type CanvasItem,
  type CanvasNote,
  type CanvasSection,
  type CanvasShape,
  type CanvasShapeItem,
  type CanvasText,
  type CanvasTextSize,
  parseCanvas,
} from "./canvas"
export { CsvParseError, type CsvTable, formatCsv, parseCsv } from "./csv"
export {
  checkFormula,
  evaluateComputedColumns,
  FORMULA_ERRORS,
  type FormulaErrorCode,
  type FormulaNode,
  type FormulaOperator,
  formulaDependencies,
  parseFormula,
} from "./formula"
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
  type CanvasOutline,
  type CanvasOutlineItem,
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
export { ARTIFACT_TONES, type ArtifactTone } from "./tones"
export {
  NUMERIC_COLUMN_TYPES,
  parseSheetDate,
  parseSheetNumber,
  parseWorkbook,
  type SheetChartAggregate,
  type SheetChartType,
  type SheetColumnFormat,
  type SheetColumnType,
  type SheetHighlight,
  type SheetTotal,
  sheetFilePath,
  WORKBOOK_FILE,
  type Workbook,
  type WorkbookChart,
  type WorkbookSheet,
} from "./workbook"
