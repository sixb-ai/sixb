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
import type { ProjectionDispatchDescriptor } from "@sixb/core/internal/projections"
import type { RuntimeEventScheduleDefinition } from "@sixb/core/internal/schedules"
import type {
  AutomaticWorkflowRunDispatchInput,
  WorkflowRunDispatchPort,
} from "@sixb/core/internal/workflows"
import type { LakeStorage } from "@sixb/core/lake-storage"
import type {
  NewQueueJob,
  PipelineRunRequestedQueueJob,
  ProjectionRunRequestedQueueJob,
  SyncRunRequestedQueueJob,
  WorkflowRunRequestedQueueJob,
} from "@sixb/core/queues"
import type { ProjectionRunStorage } from "@sixb/core/storage"

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

export interface ProjectionRunRequestedJobTemplate {
  readonly type: ProjectionRunRequestedQueueJob["type"]
  readonly payload: ProjectionDispatchDescriptor
}

export type OrchestratorJob =
  | { readonly queue: "syncRuns"; readonly job: NewQueueJob<SyncRunRequestedQueueJob> }
  | { readonly queue: "pipelines"; readonly job: NewQueueJob<PipelineRunRequestedQueueJob> }
  | { readonly queue: "projections"; readonly job: ProjectionRunRequestedJobTemplate }
  | { readonly queue: "workflows"; readonly job: NewQueueJob<WorkflowRunRequestedQueueJob> }

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

export interface ProjectionDispatchPorts {
  readonly lakeStorage: Pick<LakeStorage, "getLatestVersion" | "getVersion" | "listVersions">
  readonly projectionRuns: Pick<ProjectionRunStorage, "getById">
}

export type WorkflowDispatchInput = AutomaticWorkflowRunDispatchInput
export type WorkflowDispatcherPort = WorkflowRunDispatchPort

export interface OrchestratorDispatchers {
  /** Required when the compiled routes contain automatic workflow triggers. */
  readonly workflows?: WorkflowDispatcherPort
}

export interface OrchestratorRuntimeOptions {
  readonly projectId: string
  readonly events: DomainEventLog
  readonly queues: Queues
  readonly routes: OrchestratorRoutes
  readonly dispatchers: OrchestratorDispatchers
  /** Required when the compiled routes contain projections. */
  readonly projectionDispatch?: ProjectionDispatchPorts
}
