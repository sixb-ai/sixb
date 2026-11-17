import type { DatasetDefinition } from "../datasets"
import { compareStrings } from "../json"
import { planDatasetDefinitionUpdate } from "../lake-storage/definition-updates"
import type {
  DatasetShipStep,
  DefinitionChange,
  DefinitionsManifest,
  ManifestDiff,
  ManifestProjection,
  ProjectionShipStep,
} from "./types"

/** What changes from `base` to `head`, and what deploying `head` over `base` does to stored data. */
export function diffManifests(base: DefinitionsManifest, head: DefinitionsManifest): ManifestDiff {
  return {
    changes: diffDefinitions(base, head),
    plan: {
      projections: diffProjections(base.projections, head.projections),
      datasets: diffDatasets(base.datasets, head.datasets),
    },
  }
}

function diffDefinitions(base: DefinitionsManifest, head: DefinitionsManifest): DefinitionChange[] {
  const key = (definition: { readonly kind: string; readonly id: string }) =>
    `${definition.kind}:${definition.id}`
  const before = new Map(base.definitions.map((definition) => [key(definition), definition]))
  const after = new Map(head.definitions.map((definition) => [key(definition), definition]))
  const changes: DefinitionChange[] = []

  for (const [id, definition] of after) {
    const previous = before.get(id)
    if (previous?.hash === definition.hash) continue
    changes.push({
      kind: definition.kind,
      id: definition.id,
      change: previous ? "changed" : "added",
      file: definition.file,
    })
  }
  for (const [id, definition] of before) {
    if (after.has(id)) continue
    changes.push({
      kind: definition.kind,
      id: definition.id,
      change: "removed",
      file: definition.file,
    })
  }

  return changes.sort(
    (left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id)
  )
}

function diffProjections(
  base: readonly ManifestProjection[],
  head: readonly ManifestProjection[]
): ProjectionShipStep[] {
  const before = new Map(base.map((projection) => [projection.id, projection.revision]))
  const after = new Map(head.map((projection) => [projection.id, projection.revision]))
  const steps: ProjectionShipStep[] = []

  for (const [id, revision] of after) {
    const previous = before.get(id)
    if (previous === undefined) steps.push({ id, change: "build" })
    else if (previous !== revision) steps.push({ id, change: "rebuild" })
  }
  for (const id of before.keys()) {
    if (!after.has(id)) steps.push({ id, change: "remove" })
  }

  return steps.sort((left, right) => compareStrings(left.id, right.id))
}

function diffDatasets(
  base: readonly DatasetDefinition[],
  head: readonly DatasetDefinition[]
): DatasetShipStep[] {
  const before = new Map(base.map((dataset) => [dataset.id, dataset]))
  const after = new Map(head.map((dataset) => [dataset.id, dataset]))
  const steps: DatasetShipStep[] = []

  for (const [id, dataset] of after) {
    const previous = before.get(id)
    if (!previous) {
      steps.push({ id, change: "create" })
      continue
    }
    const step = planDatasetStep(previous, dataset)
    if (step) steps.push(step)
  }
  for (const id of before.keys()) {
    if (!after.has(id)) steps.push({ id, change: "remove" })
  }

  return steps.sort((left, right) => compareStrings(left.id, right.id))
}

/** The same plan the lake applies on deploy, so a change storage refuses shows before it ships. */
function planDatasetStep(
  existing: DatasetDefinition,
  requested: DatasetDefinition
): DatasetShipStep | null {
  const { id } = requested
  try {
    const plan = planDatasetDefinitionUpdate(existing, requested)
    if (plan.schema.kind === "addNullableColumns") {
      return { id, change: "addColumns", columns: plan.schema.columns.map((column) => column.name) }
    }
    return plan.changed ? { id, change: "metadata" } : null
  } catch (error) {
    return { id, change: "refused", reason: error instanceof Error ? error.message : String(error) }
  }
}
