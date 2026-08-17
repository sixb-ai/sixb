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

export function getProjectionDispatchDescriptors(
  owner: object
): readonly ProjectionDispatchDescriptor[] {
  return getProjectionRegistry(owner).getDispatchDescriptors()
}

export function shareProjectionRegistry(source: object, target: object): void {
  registerProjectionRegistry(target, getProjectionRegistry(source))
}
