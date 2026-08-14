import type { LakeStorage, OntologyDefinitionCatalog, SixbDefinitions } from "@sixb/core"
import type { ProjectionMaterializationIdentity } from "@sixb/core/internal/materialization"
import type {
  ProjectionRunClaim,
  ProjectionRunRecord,
  ProjectionRunStorage,
} from "@sixb/core/storage"

export interface ProjectionWorkerContext {
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  readonly lakeStorage: LakeStorage
  readonly projectionRunsStorage: ProjectionRunStorage
  readonly datasets: Pick<SixbDefinitions["datasets"], "getById">
  readonly projections: Pick<SixbDefinitions["projections"], "getById">
}

export type ProjectionJob = ProjectionMaterializationIdentity & {
  /** Stable logical run id; identical to the durable queue job id. */
  readonly id: string
}

export interface RunProjectionJobInput {
  readonly runtime: ProjectionWorkerContext
  readonly job: ProjectionJob
  readonly signal?: AbortSignal
  /**
   * Clock for the missing-target grace window, measured from the run's own `startedAt`.
   *
   * A test seam: production reads `Date.now()`. Nothing else here needs a clock, so it is
   * not a general injection point.
   */
  readonly now?: () => number
  /** Test seam only. Production always uses the protocol constant (500 physical rows). */
  readonly telemetryBatchSize?: number
  readonly onRunFailed?: ProjectionRunFailedHandler
}

export type ProjectionRunFailedHandler = (error: unknown, run: ProjectionRunRecord) => void

export interface ProjectionJobResult {
  readonly run: ProjectionRunRecord
  /** True when a terminal redelivery required no source read. */
  readonly replayedTerminal: boolean
}

export type ClaimedProjectionExecution = ProjectionRunClaim
