export type DocumentPreviewPresentation = "panel" | "dialog" | "canvas"

export function documentPreviewPresentation(
  compact: boolean,
  isMobile: boolean,
  hasCanvas: boolean = false,
  split: boolean = false
): DocumentPreviewPresentation {
  if (isMobile) return "dialog"
  if (split) return "panel"
  if (compact && hasCanvas) return "canvas"
  return compact ? "dialog" : "panel"
}
