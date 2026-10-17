/**
 * What a client needs to show an artifact the way publishing read it: the kinds, the slugs its
 * headings get, and its theme. Browser-safe: no storage, no Bun APIs.
 */

export { ARTIFACT_KINDS } from "./kinds"
export { createHeadingSlugger } from "./outline"
export { ARTIFACT_THEME_FILE, type ArtifactTheme, parseArtifactTheme } from "./theme"
