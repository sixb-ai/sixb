import type {
  DatasetVersionCommittedEvent,
  DomainEvent,
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

type ScheduleTriggeredRouteKey =
  `${ScheduleTriggeredEvent["type"]}:${ScheduleTriggeredEvent["payload"]["scheduleId"]}`

type SyncRunFinishedRouteKey =
  `${SyncRunFinishedEvent["type"]}:${SyncRunFinishedEvent["payload"]["syncId"]}:${SyncRunFinishedEvent["payload"]["status"]}`

type PipelineRunFinishedRouteKey =
  `${PipelineRunFinishedEvent["type"]}:${PipelineRunFinishedEvent["payload"]["pipelineId"]}:${PipelineRunFinishedEvent["payload"]["status"]}`

type DatasetVersionCommittedRouteKey =
  `${DatasetVersionCommittedEvent["type"]}:${DatasetVersionCommittedEvent["payload"]["datasetId"]}`

export type OrchestratorRouteKey =
  | ScheduleTriggeredRouteKey
  | SyncRunFinishedRouteKey
  | PipelineRunFinishedRouteKey
  | DatasetVersionCommittedRouteKey

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

export interface OrchestratorRoute {
  readonly eventType: DomainEvent["type"]
  readonly jobs: readonly OrchestratorJob[]
}

export type OrchestratorRoutes = ReadonlyMap<OrchestratorRouteKey, OrchestratorRoute>

export interface CompileRoutesParams {
  readonly syncs: readonly SyncDefinition[]
  readonly pipelines: readonly PipelineDefinition[]
  readonly projections?: readonly ProjectionDefinition[]
  readonly workflows?: readonly WorkflowDefinition[]
}

export interface CompileRoutesDiagnostic {
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
