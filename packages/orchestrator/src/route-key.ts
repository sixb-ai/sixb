import type { StoredDomainEvent } from "@pario/core"
import type { OrchestratorRouteKey } from "./types"

/**
 * Only place in the runtime that knows how to extract a routing id from a
 * specific event payload. Extending to a new event type = one case here.
 */
export function routeKeyForEvent(event: StoredDomainEvent): OrchestratorRouteKey | null {
  switch (event.type) {
    case "schedule.triggered":
      return `schedule.triggered:${event.payload.scheduleId}`
    case "sync.run.finished":
      return `sync.run.finished:${event.payload.syncId}:${event.payload.status}`
    case "pipeline.run.finished":
      return `pipeline.run.finished:${event.payload.pipelineId}:${event.payload.status}`
    case "dataset.version.committed":
      return `dataset.version.committed:${event.payload.datasetId}`
    default:
      return null
  }
}
