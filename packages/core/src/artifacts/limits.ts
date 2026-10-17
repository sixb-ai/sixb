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
  maxSheetColumns: 200,
  maxCharts: 10,
  maxChartSeries: 5,
  /** One slice per theme chart color, so no two slices share one. */
  maxPieSlices: 5,
  /** A deck's `index.html` is parsed whole when it is published. */
  maxDeckBytes: 2 * 1024 * 1024,
  maxSlides: 100,
  /** `artifact:` addresses one version may use. */
  maxReferences: 200,
} as const
