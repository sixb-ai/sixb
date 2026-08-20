import { sha256Canonical } from "../materialization/identity"
import type { ProjectionMaterializationIdentity } from "../materialization/model"
import type { ProjectionRegistry } from "./registry"
import type { ProjectionDispatchDescriptor } from "./types"

const projectionRegistryKey: unique symbol = Symbol("sixb.projectionRegistry")

interface ProjectionRegistryOwner {
  readonly [projectionRegistryKey]?: ProjectionRegistry
}

export function registerProjectionRegistry(owner: object, registry: ProjectionRegistry): void {
  const registered = (owner as ProjectionRegistryOwner)[projectionRegistryKey]
  if (registered && registered !== registry) {
    throw new Error("[Sixb] Projection registry is already registered for this owner.")
  }

  Object.defineProperty(owner, projectionRegistryKey, {
    configurable: false,
    enumerable: false,
    value: registry,
    writable: false,
  })
}

export function getProjectionRegistry(owner: object): ProjectionRegistry {
  const registry = (owner as ProjectionRegistryOwner)[projectionRegistryKey]
  if (registry) return registry
  throw new Error("[Sixb] Projection registry is not registered for this runtime.")
}

/** Read-only orchestration view without exposing the registry capability to callers. */
export function getProjectionDispatchDescriptors(
  owner: object
): readonly ProjectionDispatchDescriptor[] {
  return getProjectionRegistry(owner).getDispatchDescriptors()
}

/** Copies the opaque registry capability when an internal runtime context is reconstructed. */
export function shareProjectionRegistry(source: object, target: object): void {
  registerProjectionRegistry(target, getProjectionRegistry(source))
}

export function createProjectionRunId(
  projectId: string,
  identity: ProjectionMaterializationIdentity
): string {
  return sha256Canonical({
    projectId,
    projectionId: identity.projectionId,
    projectionKind: identity.projectionKind,
    protocol: identity.protocol,
    datasetId: identity.datasetVersion.datasetId,
    versionId: identity.datasetVersion.versionId,
    createdAt: identity.datasetVersion.createdAt,
    ontologyRevision: identity.ontologyRevision,
    projectionRevision: identity.projectionRevision,
    ownershipHash: identity.ownershipHash,
  })
}

/**
 * What the projection worker needs and an app author does not.
 *
 * `projectionTargetOf` derives the object types a projection writes, to record them on the run.
 * `validateTelemetryProjectionFieldMapping` re-checks a telemetry mapping against the dataset schema
 * before writing. Both are plumbing, so they live here instead of on the `@sixb/core` root.
 */
export { projectionTargetOf } from "./builders"
export { validateTelemetryProjectionFieldMapping } from "./validation"

export type { ProjectionDispatchDescriptor, ProjectionMaterializationIdentity, ProjectionRegistry }
