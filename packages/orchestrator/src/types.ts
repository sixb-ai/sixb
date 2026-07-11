import type {
  DatasetVersionCommittedEvent,
  DomainEvent,
  EventsRuntime,
  NewQueueJob,
  PipelineDefinition,
  PipelineRunRequestedQueueJob,
  ProjectionDefinition,
  ProjectionRunRequestedQueueJob,
  Queues,
  RuntimeEventScheduleDefinition,
  ScheduleDefinition,
  ScheduleTriggeredEvent,
  SyncDefinition,
  SyncRunRequestedQueueJob,
  WorkflowDefinition,
  WorkflowRunRequestedQueueJob,
  WorkflowScheduleTriggerDefinition,
} from "@sixb/core"

export type RoutableProjectionDefinition = ProjectionDefinition

type ScheduleTriggeredRouteKey =
  `${ScheduleTriggeredEvent["type"]}:${ScheduleTriggeredEvent["payload"]["scheduleId"]}`

type DatasetVersionCommittedRouteKey =
  `${DatasetVersionCommittedEvent["type"]}:${DatasetVersionCommittedEvent["payload"]["datasetId"]}`
type EventScheduleRouteKey = `event-schedule:${DomainEvent["type"]}:${string}`

export type OrchestratorRouteKey =
  | ScheduleTriggeredRouteKey
  | DatasetVersionCommittedRouteKey
  | EventScheduleRouteKey

export type ProjectionRunRequestedJobTemplate = Omit<
  NewQueueJob<ProjectionRunRequestedQueueJob>,
  "payload" | "availableAt" | "metadata"
> & {
  readonly payload: Omit<ProjectionRunRequestedQueueJob["payload"], "versionId">
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

export interface OrchestratorRuntimeOptions {
  readonly projectId: string
  readonly events: EventsRuntime
  readonly queues: Queues
  readonly routes: OrchestratorRoutes
}
