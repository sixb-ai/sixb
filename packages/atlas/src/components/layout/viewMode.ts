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
  "rules",
  "ontology",
  "settings",
])

export function getViewModeFromPath(pathname: string): ViewMode {
  if (pathname === "/" || pathname === "") return "home"
  const segments = pathname.split("/").filter(Boolean)
  const view = segments[0]
  if (view === "runs") return "workflows"
  if (view === "actions" && segments[1] === "runs") return "actions"
  if (view && KNOWN_VIEWS.has(view)) return view as ViewMode
  return "home"
}
