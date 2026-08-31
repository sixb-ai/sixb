import type {
  DatasetVersionCommittedEvent,
  DomainEvent,
  DomainEventLog,
  PipelineDefinition,
  Queues,
  ScheduleDefinition,
  ScheduleTriggeredEvent,
  SyncDefinition,
  WorkflowDefinition,
  WorkflowScheduleTriggerDefinition,
} from "@sixb/core"
import type {
  AutomaticPipelineRunDispatchInput,
  PipelineRunDispatchPort,
} from "@sixb/core/internal/pipelines"
import type {
  ProjectionDispatchDescriptor,
  ProjectionRunDispatchInput,
  ProjectionRunDispatchPort,
} from "@sixb/core/internal/projections"
import type { RuntimeEventScheduleDefinition } from "@sixb/core/internal/schedules"
import type { AutomaticSyncRunDispatchInput, SyncRunDispatchPort } from "@sixb/core/internal/syncs"
import type {
  AutomaticWorkflowRunDispatchInput,
  WorkflowRunDispatchPort,
} from "@sixb/core/internal/workflows"
import type { LakeStorage } from "@sixb/core/lake-storage"

export type RoutableProjectionDefinition = ProjectionDispatchDescriptor

type ScheduleTriggeredRouteKey =
  `${ScheduleTriggeredEvent["type"]}:${ScheduleTriggeredEvent["payload"]["scheduleId"]}`

type DatasetVersionCommittedRouteKey =
  `${DatasetVersionCommittedEvent["type"]}:${DatasetVersionCommittedEvent["payload"]["datasetId"]}`
type EventScheduleRouteKey = `event-schedule:${DomainEvent["type"]}:${string}`

export type OrchestratorRouteKey =
  | ScheduleTriggeredRouteKey
  | DatasetVersionCommittedRouteKey
  | EventScheduleRouteKey

export interface ProjectionDispatchJobTemplate {
  readonly type: "projection.dispatch"
  readonly payload: ProjectionDispatchDescriptor
}

export interface WorkflowRunDispatchJobTemplate {
  readonly type: "workflow.run.requested"
  readonly payload: {
    readonly workflowId: string
    readonly input?: Readonly<Record<string, unknown>>
  }
}

export interface SyncRunDispatchJobTemplate {
  readonly type: "sync.run.requested"
  readonly payload: { readonly syncId: string }
}

export interface PipelineRunDispatchJobTemplate {
  readonly type: "pipeline.run.requested"
  readonly payload: { readonly pipelineId: string }
}

export type OrchestratorJob =
  | { readonly queue: "syncRuns"; readonly job: SyncRunDispatchJobTemplate }
  | { readonly queue: "pipelines"; readonly job: PipelineRunDispatchJobTemplate }
  | { readonly queue: "projections"; readonly job: ProjectionDispatchJobTemplate }
  | { readonly queue: "workflows"; readonly job: WorkflowRunDispatchJobTemplate }

export type OrchestratorEventScheduleTarget =
  | { readonly queue: "syncRuns"; readonly syncId: string }
  | { readonly queue: "pipelines"; readonly pipelineId: string }
  | {
      readonly queue: "workflows"
      readonly workflowId: string
      readonly mapper?: WorkflowScheduleTriggerDefinition["mapper"]
    }

export interface OrchestratorEventScheduleBinding {
  readonly schedule: RuntimeEventScheduleDefinition
  readonly targets: readonly OrchestratorEventScheduleTarget[]
}

export interface OrchestratorRoute {
  readonly eventType: DomainEvent["type"]
  readonly jobs: readonly OrchestratorJob[]
  readonly eventSchedules?: readonly OrchestratorEventScheduleBinding[]
}

export type OrchestratorRoutes = ReadonlyMap<OrchestratorRouteKey, OrchestratorRoute>

export interface CompileRoutesParams {
  readonly schedules: readonly ScheduleDefinition[]
  readonly syncs: readonly SyncDefinition[]
  readonly pipelines: readonly PipelineDefinition[]
  readonly projections?: readonly RoutableProjectionDefinition[]
  readonly workflows?: readonly WorkflowDefinition[]
}

export type ScheduleConsumerKind = "sync" | "pipeline" | "workflow"

export type CompileRoutesDiagnostic =
  | {
      readonly type: "schedule.reference.unknown"
      readonly scheduleId: string
      readonly consumerKind: ScheduleConsumerKind
      readonly consumerId: string
    }
  | {
      readonly type: "workflow.schedule.input-required"
      readonly workflowId: string
      readonly scheduleId: string
      readonly inputFields: readonly string[]
    }

export interface CompileRoutesResult {
  readonly routes: OrchestratorRoutes
  readonly diagnostics: readonly CompileRoutesDiagnostic[]
}

export interface ProjectionReconciliationPorts {
  readonly lakeStorage: Pick<LakeStorage, "getLatestVersion" | "getVersion" | "listVersions">
}

export type WorkflowDispatchInput = AutomaticWorkflowRunDispatchInput
export type WorkflowDispatcherPort = WorkflowRunDispatchPort
export type SyncDispatchInput = AutomaticSyncRunDispatchInput
export type SyncDispatcherPort = SyncRunDispatchPort
export type PipelineDispatchInput = AutomaticPipelineRunDispatchInput
export type PipelineDispatcherPort = PipelineRunDispatchPort
export type ProjectionDispatchInput = ProjectionRunDispatchInput
export type ProjectionDispatcherPort = ProjectionRunDispatchPort

export interface OrchestratorDispatchers {
  /** Required when the compiled routes contain automatic Sync triggers. */
  readonly syncs?: SyncDispatcherPort
  /** Required when the compiled routes contain automatic Pipeline triggers. */
  readonly pipelines?: PipelineDispatcherPort
  /** Required when the compiled routes contain automatic workflow triggers. */
  readonly workflows?: WorkflowDispatcherPort
  /** Required when the compiled routes contain Projection triggers. */
  readonly projections?: ProjectionDispatcherPort
}

export interface OrchestratorRuntimeOptions {
  readonly projectId: string
  readonly events: DomainEventLog
  readonly queues: Queues
  readonly routes: OrchestratorRoutes
  readonly dispatchers: OrchestratorDispatchers
  /** Required when the compiled routes contain projections. */
  readonly projectionReconciliation?: ProjectionReconciliationPorts
}
