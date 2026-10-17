/**
 * Something about a published version worth fixing that did not stop it from publishing. A warning
 * names the part it concerns, so a viewer can point at it.
 */
export interface ArtifactWarning {
  readonly code: string
  readonly message: string
  /** The slide, sheet, section, or file the warning is about. */
  readonly part?: string
}
