import type { ViewMode } from "./Sidebar"

/** Atlas's own page: the agent. Everything else moved into the project's app. */
export function getViewModeFromPath(pathname: string): ViewMode | null {
  return pathname.split("/").filter(Boolean)[0] === "agents" ? "agents" : null
}
