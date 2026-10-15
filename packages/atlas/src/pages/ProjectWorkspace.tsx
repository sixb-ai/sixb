import { decodeObjectId } from "@sixb/client"
import { type Location, Route, Routes } from "react-router-dom"
import { MovedToApp } from "../components/MovedToApp"
import { workflowRunsInApp } from "../lib/app-url"

/**
 * Every Atlas page lives in the project's app now; old links follow their page there. Atlas keeps
 * only its agent.
 */
export function ProjectWorkspace() {
  return (
    <Routes>
      <Route index element={<MovedToApp to={objectsInApp} />} />
      <Route path="home" element={<MovedToApp to={objectsInApp} />} />
      <Route path="objects" element={<MovedToApp to={objectsInApp} />} />
      <Route path="ontology" element={<MovedToApp to={ontologyInApp} />} />
      <Route
        path="ontology/:typeId"
        element={
          <MovedToApp
            to={(location) =>
              `/ontology/object-types${location.pathname.slice("/ontology".length)}`
            }
          />
        }
      />
      {ontologyViews.map((view) => (
        <Route key={view} path={`${view}/*`} element={<MovedToApp prefix="/ontology" />} />
      ))}
      <Route
        path="actions/runs/:runId"
        element={
          <MovedToApp
            to={(location) =>
              `/observability/runs/actions${location.pathname.slice("/actions/runs".length)}`
            }
          />
        }
      />
      {dataViews.map((view) => (
        <Route key={view} path={`${view}/*`} element={<MovedToApp prefix="/data" />} />
      ))}
      <Route path="logs" element={<MovedToApp prefix="/observability" />} />
      <Route path="ai-usage" element={<MovedToApp prefix="/observability" />} />
      <Route
        path="runs"
        element={<MovedToApp to={(location) => workflowRunsInApp(location.search)} />}
      />
      <Route
        path="runs/:runId"
        element={
          <MovedToApp
            to={(location) =>
              `/observability/runs/workflows${location.pathname.slice("/runs".length)}`
            }
          />
        }
      />
      <Route path="settings/*" element={<MovedToApp />} />
      <Route path=":objectId" element={<MovedToApp to={objectInApp} />} />
      <Route path="*" element={<MovedToApp to={() => "/"} />} />
    </Routes>
  )
}

const ontologyViews = ["actions", "workflows", "rules"] as const
const dataViews = ["connectors", "syncs", "datasets", "pipelines", "projections"] as const

/** Atlas's Objects, `?class=` filtering one type, as the app's. */
export function objectsInApp(location: Location): string {
  const type = new URLSearchParams(location.search).get("class")
  return type ? `/ontology/objects?type=${encodeURIComponent(type)}` : "/ontology/objects"
}

/**
 * Atlas's ontology, `?type=` selecting one in the graph and `&view=details` opening it, on the
 * same `&tab=`.
 */
export function ontologyInApp(location: Location): string {
  const params = new URLSearchParams(location.search)
  const type = params.get("type")
  if (type && params.get("view") === "details") {
    const tab = params.get("tab")
    return `/ontology/object-types/${encodeURIComponent(type)}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`
  }
  return type ? `/ontology/graph?type=${encodeURIComponent(type)}` : "/ontology/graph"
}

/** An object's Atlas page, `/:objectTypeId~:primaryId`, as its page in the app. */
export function objectInApp(location: Location): string {
  let object: ReturnType<typeof decodeObjectId>
  try {
    object = decodeObjectId(decodeURIComponent(location.pathname.slice(1)))
  } catch {
    // A malformed escape, such as a truncated `%E0%A4%A`, names no object.
    return "/ontology/objects"
  }
  return object
    ? `/objects/${encodeURIComponent(object.objectTypeId)}/${encodeURIComponent(object.primaryId)}`
    : "/ontology/objects"
}
