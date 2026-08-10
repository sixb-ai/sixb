export type DocumentPreviewPresentation = "panel" | "dialog"

export function documentPreviewPresentation(
  compact: boolean,
  isMobile: boolean
): DocumentPreviewPresentation {
  return compact || isMobile ? "dialog" : "panel"
}
