// Where the built-in pages live, for links from one to another.

/** An object's page. Every object has one, whatever its type. */
export function objectHref(objectTypeId: string, primaryId: string): string {
  return `/objects/${encodeURIComponent(objectTypeId)}/${encodeURIComponent(primaryId)}`
}

/** An object type's page in Ontology › Object types. */
export function objectTypeHref(objectTypeId: string): string {
  return `/ontology/object-types/${encodeURIComponent(objectTypeId)}`
}

/** A type's objects in Ontology › Objects. */
export function objectsOfTypeHref(objectTypeId: string): string {
  return `/ontology/objects?type=${encodeURIComponent(objectTypeId)}`
}

/** Ontology › Graph with one type selected. */
export function graphTypeHref(objectTypeId: string): string {
  return `/ontology/graph?type=${encodeURIComponent(objectTypeId)}`
}

/** A rule's page in Ontology › Rules. */
export function ruleHref(ruleId: string): string {
  return `/ontology/rules/${encodeURIComponent(ruleId)}`
}

/** A workflow's canvas in Ontology › Workflows. */
export function workflowHref(workflowId: string): string {
  return `/ontology/workflows/${encodeURIComponent(workflowId)}`
}

/** A workflow's canvas with one run over it, and one of its steps open. */
export function workflowCanvasHref(workflowId: string, runId: string, nodeId?: string): string {
  const params = new URLSearchParams({ run: runId })
  if (nodeId) params.set("node", `node:${nodeId}`)
  return `${workflowHref(workflowId)}?${params}`
}

/** A workflow run's page in Observability › Runs. */
export function workflowRunHref(runId: string): string {
  return `/observability/runs/workflows/${encodeURIComponent(runId)}`
}

/** An action run's page in Observability › Runs. */
export function actionRunHref(runId: string): string {
  return `/observability/runs/actions/${encodeURIComponent(runId)}`
}
