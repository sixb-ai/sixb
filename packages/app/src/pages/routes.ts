// Where the built-in pages live, for links from one to another.

/** An object's page. Every object has one, whatever its type. */
export function objectHref(objectTypeId: string, primaryId: string): string {
  return `/objects/${encodeURIComponent(objectTypeId)}/${encodeURIComponent(primaryId)}`
}

/** The gallery of every artifact the reader can open. */
export const ARTIFACTS_HREF = "/artifacts"

/** An artifact's own page, at a version and part when given. */
export function artifactHref(
  artifactId: string,
  options: { readonly version?: number; readonly part?: string } = {}
): string {
  const params = new URLSearchParams()
  if (options.version !== undefined) params.set("v", String(options.version))
  if (options.part) params.set("part", options.part)
  const query = params.toString()
  return `/artifacts/${encodeURIComponent(artifactId)}${query ? `?${query}` : ""}`
}

/** An object type's page in Console › Object types. */
export function objectTypeHref(objectTypeId: string): string {
  return `/console/object-types/${encodeURIComponent(objectTypeId)}`
}

/** A type's objects in Console › Objects. */
export function objectsOfTypeHref(objectTypeId: string): string {
  return `/console/objects?type=${encodeURIComponent(objectTypeId)}`
}

/** Console › Graph with one type selected. */
export function graphTypeHref(objectTypeId: string): string {
  return `/console/graph?type=${encodeURIComponent(objectTypeId)}`
}

/** A rule's page in Console › Rules. */
export function ruleHref(ruleId: string): string {
  return `/console/rules/${encodeURIComponent(ruleId)}`
}

/** A workflow's canvas in Console › Workflows. */
export function workflowHref(workflowId: string): string {
  return `/console/workflows/${encodeURIComponent(workflowId)}`
}

/** A workflow's canvas with one run over it, and one of its steps open. */
export function workflowCanvasHref(workflowId: string, runId: string, nodeId?: string): string {
  const params = new URLSearchParams({ run: runId })
  if (nodeId) params.set("node", `node:${nodeId}`)
  return `${workflowHref(workflowId)}?${params}`
}

/** A sync's page in Console › Syncs, with its runs. */
export function syncHref(syncId: string): string {
  return `/console/syncs/${encodeURIComponent(syncId)}`
}

/** A dataset's rows in Console › Datasets, at one version when given. */
export function datasetHref(datasetId: string, versionId?: string): string {
  const query = versionId ? `?${new URLSearchParams({ version: versionId })}` : ""
  return `/console/datasets/${encodeURIComponent(datasetId)}${query}`
}

/** A pipeline's canvas in Console › Pipelines, with one of its runs open when given. */
export function pipelineHref(pipelineId: string, runId?: string): string {
  const query = runId ? `?${new URLSearchParams({ run: runId })}` : ""
  return `/console/pipelines/${encodeURIComponent(pipelineId)}${query}`
}

/** A projection's page in Console › Projections, with its mapping and runs. */
export function projectionHref(projectionId: string): string {
  return `/console/projections/${encodeURIComponent(projectionId)}`
}

/** A workflow run's page, under Console › Workflows. */
export function workflowRunHref(runId: string): string {
  return `/console/workflows/runs/${encodeURIComponent(runId)}`
}

/** An action run's page, under Console › Actions. */
export function actionRunHref(runId: string): string {
  return `/console/actions/runs/${encodeURIComponent(runId)}`
}

/** Someone else's Agent conversation, read-only, in Settings › Activity. */
export function observedThreadHref(threadId: string): string {
  return `/settings/activity/threads/${encodeURIComponent(threadId)}`
}
