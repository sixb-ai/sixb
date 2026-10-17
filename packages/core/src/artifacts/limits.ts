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
} as const
