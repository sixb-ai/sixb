import type { ProjectionMaterializationIdentity } from "../materialization/model"
import type { ProjectionRegistry } from "./registry"
import type { ProjectionDispatchDescriptor } from "./types"

/**
 * What the projection worker needs and an app author does not.
 *
 * `projectionTargetOf` derives the object types a projection writes, to record them on the run.
 * `validateTelemetryProjectionFieldMapping` re-checks a telemetry mapping against the dataset schema
 * before writing. `parseDatasetTimestamp` keeps worker timestamps aligned with the materializer's
 * authoritative validation. These are plumbing, so they live here instead of on the
 * `@sixb/core` root.
 */
export { projectionTargetOf } from "./builders"
export {
  getProjectionDispatchDescriptors,
  getProjectionRegistry,
  registerProjectionRegistry,
  shareProjectionRegistry,
} from "./capability"
export type {
  ProjectionRunDispatcherDependencies,
  ProjectionRunDispatchInput,
  ProjectionRunDispatchPort,
  ProjectionRunDispatchResult,
} from "./run-dispatch"
export {
  PROJECTION_TELEMETRY_BATCH_SIZE,
  ProjectionRunDispatcher,
} from "./run-dispatch"
export { createProjectionRunId } from "./run-id"
export { parseDatasetTimestamp } from "./timestamp"
export { validateTelemetryProjectionFieldMapping } from "./validation"

export type { ProjectionDispatchDescriptor, ProjectionMaterializationIdentity, ProjectionRegistry }
