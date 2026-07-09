import type { ViewMode } from "./Sidebar"

export const KNOWN_VIEWS = new Set([
  "home",
  "datasets",
  "connectors",
  "syncs",
  "projections",
  "pipelines",
  "workflows",
  "actions",
  "runs",
  "agents",
  "logs",
  "rules",
  "ontology",
  "settings",
])

export function getViewModeFromPath(pathname: string): ViewMode {
  if (pathname === "/" || pathname === "") return "home"
  const segments = pathname.split("/").filter(Boolean)
  const view = segments[0]
  if (view === "runs") {
    if (segments[1] === "sync") return "syncs"
    if (segments[1] === "pipeline") return "pipelines"
    if (segments[1] === "action") return "actions"
    return "workflows"
  }
  if (view === "actions" && segments[1] === "runs") return "actions"
  if (view && KNOWN_VIEWS.has(view)) return view as ViewMode
  return "home"
}
