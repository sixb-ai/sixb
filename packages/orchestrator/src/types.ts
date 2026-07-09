import type {
  DatasetVersionCommittedEvent,
  DomainEvent,
  DomainTriggerDefinition,
  EventsRuntime,
  NewQueueJob,
  PipelineDefinition,
  PipelineRunFinishedEvent,
  PipelineRunRequestedQueueJob,
  ProjectionDefinition,
  ProjectionRunRequestedQueueJob,
  Queues,
  ScheduleTriggeredEvent,
  SyncDefinition,
  SyncRunFinishedEvent,
  SyncRunRequestedQueueJob,
  WorkflowDefinition,
  WorkflowRunRequestedQueueJob,
} from "@sixb/core"

export type RoutableProjectionDefinition = ProjectionDefinition

type ScheduleTriggeredRouteKey =
  `${ScheduleTriggeredEvent["type"]}:${ScheduleTriggeredEvent["payload"]["scheduleId"]}`

type SyncRunFinishedRouteKey =
  `${SyncRunFinishedEvent["type"]}:${SyncRunFinishedEvent["payload"]["syncId"]}:${SyncRunFinishedEvent["payload"]["status"]}`

type PipelineRunFinishedRouteKey =
  `${PipelineRunFinishedEvent["type"]}:${PipelineRunFinishedEvent["payload"]["pipelineId"]}:${PipelineRunFinishedEvent["payload"]["status"]}`

type DatasetVersionCommittedRouteKey =
  `${DatasetVersionCommittedEvent["type"]}:${DatasetVersionCommittedEvent["payload"]["datasetId"]}`
type TriggerEventRouteKey = `trigger:${DomainEvent["type"]}:${string}`

export type OrchestratorRouteKey =
  | ScheduleTriggeredRouteKey
  | SyncRunFinishedRouteKey
  | PipelineRunFinishedRouteKey
  | DatasetVersionCommittedRouteKey
  | TriggerEventRouteKey

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

export interface OrchestratorWorkflowTriggerBinding {
  readonly workflowId: string
  readonly triggerId: string
}

export interface OrchestratorRoute {
  readonly eventType: DomainEvent["type"]
  readonly jobs: readonly OrchestratorJob[]
  readonly workflowTriggers?: readonly OrchestratorWorkflowTriggerBinding[]
}

export type OrchestratorRoutes = ReadonlyMap<OrchestratorRouteKey, OrchestratorRoute>

export interface CompileRoutesParams {
  readonly syncs: readonly SyncDefinition[]
  readonly pipelines: readonly PipelineDefinition[]
  readonly projections?: readonly RoutableProjectionDefinition[]
  readonly workflows?: readonly WorkflowDefinition[]
  readonly triggers?: readonly DomainTriggerDefinition[]
}

export type CompileRoutesDiagnostic =
  | {
      readonly type: "workflow.schedule.input-required"
      readonly workflowId: string
      readonly scheduleId: string
      readonly inputFields: readonly string[]
    }
  | {
      readonly type: "workflow.trigger.unknown"
      readonly workflowId: string
      readonly triggerId: string
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
  readonly workflows?: readonly WorkflowDefinition[]
  readonly triggers?: readonly DomainTriggerDefinition[]
}
