/** The kinds of artifact Sixb renders. An artifact's kind is fixed when it is created. */
export const ARTIFACT_KINDS = ["document", "sheet", "slides", "file"] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value)
}
