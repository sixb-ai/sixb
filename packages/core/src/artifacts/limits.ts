/** What one version may hold. Publishing refuses a version over any of these. */
export const ARTIFACT_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 25 * 1024 * 1024,
  maxVersionBytes: 100 * 1024 * 1024,
  maxPathLength: 512,
  maxTitleLength: 200,
  /** A document's Markdown is parsed whole when it is published. */
  maxDocumentBytes: 2 * 1024 * 1024,
  maxThemeBytes: 4 * 1024,
  maxWorkbookBytes: 256 * 1024,
  /** A sheet's limits keep the grid quick and its charts readable. */
  maxSheets: 20,
  maxSheetRows: 100_000,
  /** The viewer reads a sheet whole, and reads at most this much. */
  maxSheetFileBytes: 5 * 1024 * 1024,
  maxSheetColumns: 200,
  maxCharts: 10,
  maxChartSeries: 5,
  /** One slice per theme chart color, so no two slices share one. */
  maxPieSlices: 5,
  /** A deck's `index.html` is parsed whole when it is published. */
  maxDeckBytes: 2 * 1024 * 1024,
  /** A page's `index.html` is parsed whole when it is published; its scripts and data are not. */
  maxPageBytes: 2 * 1024 * 1024,
  maxSlides: 100,
  /** A canvas's items, its live boards, and where they may sit, in pixels. */
  maxCanvasBytes: 512 * 1024,
  maxCanvasItems: 500,
  maxCanvasBoards: 40,
  minCanvasItemSize: 40,
  maxCanvasItemSize: 8000,
  maxCanvasPosition: 100_000,
  /** A note's or a text's words, in characters. */
  maxCanvasTextLength: 2000,
  /** An item's title, a shape's words, or an arrow's label, in characters. */
  maxCanvasLabelLength: 120,
  /** A board's HTML is parsed whole when it is published, as a page's is. */
  maxBoardBytes: 2 * 1024 * 1024,
  /** `artifact:` addresses one version may use. */
  maxReferences: 200,
  /** `queries/<name>.json` files, each run for every reader who opens the version. */
  maxQueries: 20,
  maxQueryBytes: 64 * 1024,
  /** What one query returns at most; past it, its result says it is truncated. */
  maxQueryRows: 10_000,
} as const

/**
 * What a page may keep for each reader with `sixb.state`, across its versions: values are JSON,
 * counted by their UTF-8 bytes as written.
 */
export const ARTIFACT_STATE_LIMITS = {
  maxKeyLength: 128,
  maxValueBytes: 64 * 1024,
  maxKeys: 100,
  maxBytes: 1024 * 1024,
} as const
