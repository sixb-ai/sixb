import { assertRuntimeAuthorizationBound } from "../../authorization"
import type { SixbRuntimeContext } from "../../runtime/types"
import { DelegatedExecutionLimitError } from "../../storage/objects/execution-limits"
import { normalizeObjectListWindow } from "../../storage/objects/pagination"

export interface ResolvedObjectListWindow {
  readonly limit: number
  readonly offset: number
  readonly maxMaterializedObjects?: number
}

/** Validate and budget a list before any provider can perform its terminal read. */
export function resolveObjectListWindow(
  runtime: Pick<SixbRuntimeContext, "projectId" | "runtimeAuthorization" | "authorization">,
  input: { readonly limit?: number; readonly offset?: number }
): ResolvedObjectListWindow {
  const { limit, offset } = normalizeObjectListWindow(input)
  const authority = assertRuntimeAuthorizationBound(runtime)
  if (authority.type !== "delegated") {
    return { limit, offset }
  }

  const maxMaterializedObjects = authority.limits.maxMaterializedObjects
  if (limit > maxMaterializedObjects) {
    throw new DelegatedExecutionLimitError("materializedObjects", maxMaterializedObjects)
  }

  return { limit, offset, maxMaterializedObjects }
}

/** Defend the Core/provider seam even if a provider returns more rows than requested. */
export function assertObjectListWithinWindow(
  window: ResolvedObjectListWindow,
  materializedObjects: number
): void {
  if (
    window.maxMaterializedObjects !== undefined &&
    materializedObjects > window.maxMaterializedObjects
  ) {
    throw new DelegatedExecutionLimitError("materializedObjects", window.maxMaterializedObjects)
  }
}
