/**
 * Where the artifact viewer opens beside a conversation. On a phone it is a dialog; beside the
 * full-page conversation, or wherever the host asks for a split, a resizable panel; beside the
 * dock, a canvas over the app when the host gives it room, else a dialog.
 */
export type ArtifactPanelPresentation = "panel" | "dialog" | "canvas"

export function artifactPanelPresentation(input: {
  readonly compact: boolean
  readonly isMobile: boolean
  readonly hasCanvas: boolean
  readonly split: boolean
}): ArtifactPanelPresentation {
  if (input.isMobile) return "dialog"
  if (input.split) return "panel"
  if (input.compact && input.hasCanvas) return "canvas"
  return input.compact ? "dialog" : "panel"
}

const PANEL_WIDTH_KEY = "sixb.agent.artifact-panel.width"

/** The panel width the reader last chose, in pixels, remembered in this browser. */
export function readArtifactPanelWidth(): number | null {
  try {
    const value = Number(globalThis.localStorage?.getItem(PANEL_WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function writeArtifactPanelWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Storage can be full or blocked; the panel simply opens at its default width next time.
  }
}
