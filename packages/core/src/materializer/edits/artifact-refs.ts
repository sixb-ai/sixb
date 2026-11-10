/**
 * Checks for the `artifactRef` values written by managed edits.
 *
 * Artifact storage is read once per commit, before the serializable transaction opens: every
 * artifact id the operations carry is looked up, and the ids that exist travel into the
 * synchronous edit pass. There, an operation may only give an object an artifact that exists. A
 * runtime commit also lists the artifacts its author may not change, and each of them is refused
 * exactly as a missing one is, so a write never tells them apart.
 *
 * A value the object already held is never checked again: an object keeps an artifact deleted
 * since, and a writer who may not change that artifact can still change the object's other values.
 */
import type { JsonValue } from "../../json"
import { MaterializationValidationError } from "../../materialization/errors"
import type { OntologyEditOperation } from "../../materialization/model"
import type { OntologyRegistry } from "../../ontology"
import {
  artifactReferenceProblem,
  artifactsUnverifiableProblem,
  collectArtifactRefIds,
} from "../../ontology/artifact-ref"
import type { MaterializerContext } from "../context"

/** The artifacts a commit's operations reference that its author may give to an object. */
export type ReferencedArtifacts =
  | { readonly kind: "loaded"; readonly reachable: ReadonlySet<string> }
  | { readonly kind: "unavailable" }

const NO_REFERENCED_ARTIFACTS: ReferencedArtifacts = { kind: "loaded", reachable: new Set() }

export async function loadReferencedArtifacts(
  context: Pick<MaterializerContext, "projectId" | "ontology" | "storage">,
  operations: readonly OntologyEditOperation[],
  unchangeableArtifactIds: readonly string[] = []
): Promise<ReferencedArtifacts> {
  const ids = new Set<string>()
  for (const operation of operations) {
    switch (operation.kind) {
      case "object.create":
      case "object.upsert":
        collectObjectArtifactRefIds(
          context.ontology,
          operation.ref.objectTypeId,
          operation.properties,
          ids
        )
        break
      case "object.patch":
        collectObjectArtifactRefIds(
          context.ontology,
          operation.ref.objectTypeId,
          operation.set,
          ids
        )
        break
      default:
        break
    }
  }
  if (ids.size === 0) return NO_REFERENCED_ARTIFACTS

  const artifacts = context.storage.artifacts
  if (!artifacts) return { kind: "unavailable" }

  // What the author may not change is refused as missing: there is no need to look it up.
  const unchangeable = new Set(unchangeableArtifactIds)
  const found = await Promise.all(
    [...ids]
      .filter((id) => !unchangeable.has(id))
      .map(async (id) => {
        const artifact = await artifacts.get({ projectId: context.projectId, id })
        return artifact ? [id] : []
      })
  )

  return { kind: "loaded", reachable: new Set(found.flat()) }
}

/**
 * Reject the artifact references an object operation introduces unless the author may give that
 * artifact to an object.
 *
 * `before` is the effective object the operation started from; ids it already held under the same
 * property are accepted as they are.
 */
export function assertIntroducedArtifactsReachable(
  ontology: OntologyRegistry,
  objectTypeId: string,
  before: Readonly<Record<string, JsonValue>> | undefined,
  after: Readonly<Record<string, JsonValue>>,
  artifacts: ReferencedArtifacts
): void {
  const objectType = ontology.resolveObjectType(objectTypeId)
  const valueTypesById = ontology.getValueTypesById()

  for (const property of objectType.properties) {
    const introduced = collectArtifactRefIds(
      property.schema,
      after[property.id],
      valueTypesById,
      new Set()
    )
    if (introduced.size === 0) continue

    const held = collectArtifactRefIds(
      property.schema,
      before?.[property.id],
      valueTypesById,
      new Set()
    )

    for (const id of introduced) {
      if (held.has(id)) continue

      const path = `Property '${objectTypeId}.${property.id}'`
      if (artifacts.kind === "unavailable") {
        throw new MaterializationValidationError(artifactsUnverifiableProblem(path, id))
      }
      if (!artifacts.reachable.has(id)) {
        throw new MaterializationValidationError(artifactReferenceProblem(path, id))
      }
    }
  }
}

function collectObjectArtifactRefIds(
  ontology: OntologyRegistry,
  objectTypeId: string,
  properties: Readonly<Record<string, JsonValue>>,
  into: Set<string>
): void {
  // Unknown types and properties are rejected by the edit pass; nothing to look up for them.
  const objectType = ontology.getObjectTypeById(objectTypeId)
  if (!objectType) return

  const valueTypesById = ontology.getValueTypesById()
  for (const property of objectType.properties) {
    collectArtifactRefIds(property.schema, properties[property.id], valueTypesById, into)
  }
}
