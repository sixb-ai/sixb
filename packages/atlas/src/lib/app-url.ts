declare global {
  interface Window {
    __SIXB_ATLAS__?: { readonly appUrl?: string }
  }
}

/**
 * Where a page that moved into the project's app now lives, or `null` when Atlas was not told the
 * app's address.
 */
export function projectAppUrl(path: string): string | null {
  const appUrl = typeof window === "undefined" ? undefined : window.__SIXB_ATLAS__?.appUrl
  return appUrl ? new URL(path, appUrl).toString() : null
}

/** Atlas's run history, filtered by `workflowId` and `status`, as the app's Runs page. */
export function workflowRunsInApp(search: string): string {
  const atlas = new URLSearchParams(search)
  const app = new URLSearchParams()
  const workflowId = atlas.get("workflowId")
  const status = atlas.get("status")
  if (workflowId) app.set("workflow", workflowId)
  if (status) app.set("status", status)
  const query = app.toString()
  return `/observability/runs${query ? `?${query}` : ""}`
}

/**
 * Opens an action run's page in the project's app, where runs moved. Without the app's address
 * there is nowhere to show it, and the action's own page stays.
 */
export function openActionRun(runId: string): void {
  const url = projectAppUrl(`/observability/runs/actions/${encodeURIComponent(runId)}`)
  if (url) window.location.assign(url)
}
