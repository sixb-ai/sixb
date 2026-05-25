import type { ViewMode } from "./Sidebar"

export const KNOWN_VIEWS = new Set([
  "home",
  "datasets",
  "connectors",
  "syncs",
  "pipelines",
  "rules",
  "ontology",
  "settings",
])

export function getViewModeFromPath(pathname: string): ViewMode {
  if (pathname === "/" || pathname === "") return "home"
  const segments = pathname.split("/").filter(Boolean)
  const view = segments[0]
  if (view && KNOWN_VIEWS.has(view)) return view as ViewMode
  return "home"
}
