import type {
  ActionsRuntime,
  AgentsRuntime,
  BlobsRuntime,
  ConnectorsRuntime,
  DatasetsRuntime,
  DomainEventLog,
  PipelinesRuntime,
  ProjectionsRuntime,
  RulesRuntime,
  SchedulesRuntime,
  SixbRuntimeContext,
  SyncsRuntime,
  WorkflowRunSource,
  WorkflowRuntimeFacade,
  WorkflowStepOutputs,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { WorkflowsRuntime } from "@sixb/core/internal/workflows"
import type { WorkflowRunResumeCause } from "@sixb/core/queues"
import type {
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunExecution,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"

export type WorkflowLogSession = ReturnType<LogsRuntime["startExecution"]>

export interface WorkflowWorkerContext extends SixbRuntimeContext {
  readonly workflowRuns: WorkflowRunStorage
  readonly sixb: WorkflowRuntimeFacade
  readonly logs?: LogsRuntime
}

export interface WorkflowWorkerSixb extends Omit<SixbRuntimeContext, "blobStorage" | "rules"> {
  readonly id: string
  readonly actions: ActionsRuntime
  readonly agents: AgentsRuntime
  readonly blobs: BlobsRuntime
  readonly connectors: ConnectorsRuntime
  readonly datasets: DatasetsRuntime
  readonly events: DomainEventLog
  readonly pipelines: PipelinesRuntime
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly schedules: SchedulesRuntime
  readonly syncs: SyncsRuntime
  readonly workflows: WorkflowsRuntime
  readonly logs?: LogsRuntime
}

export interface WorkflowJob {
  readonly id: string
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly source?: WorkflowRunSource
  readonly execution?: WorkflowRunExecution
}

export interface WorkflowResumeJob {
  readonly id: string
  readonly workflowId: string
  readonly resume: WorkflowRunResumeCause
  readonly execution?: WorkflowRunExecution
}

export type WorkflowRunFailureReporter = (error: unknown, run: WorkflowRunRecord) => void

export interface RunWorkflowJobInput {
  readonly runtime: WorkflowWorkerContext
  readonly job: WorkflowJob
  readonly signal?: AbortSignal
  readonly observer?: WorkflowRunObserver
  readonly onRunFailed?: WorkflowRunFailureReporter
}

export interface RunWorkflowResumeJobInput {
  readonly runtime: WorkflowWorkerContext
  readonly job: WorkflowResumeJob
  readonly signal?: AbortSignal
  readonly observer?: WorkflowRunObserver
  readonly onRunFailed?: WorkflowRunFailureReporter
}

export interface WorkflowRunResult {
  readonly id: string
  readonly workflowId: string
  readonly status: WorkflowRunRecord["status"]
  readonly run: WorkflowRunRecord
  readonly nodes: readonly WorkflowNodeRunRecord[]
  readonly steps: WorkflowStepOutputs
}

export interface WorkflowNodeLifecycleContext {
  readonly totalNodes: number
}

export interface WorkflowWaitingLifecycleContext {
  readonly waitingAt: Date
}

export interface WorkflowRunObserver {
  onRunStarted(run: WorkflowRunRecord): Promise<void>
  onNodeStarted(node: WorkflowNodeRunRecord, context: WorkflowNodeLifecycleContext): Promise<void>
  onRunWaiting?(run: WorkflowRunRecord, context: WorkflowWaitingLifecycleContext): Promise<void>
  onNodeWaiting?(
    node: WorkflowNodeRunRecord,
    context: WorkflowNodeLifecycleContext & WorkflowWaitingLifecycleContext
  ): Promise<void>
  onInterventionRequested?(intervention: WorkflowInterventionRecord): Promise<void>
  onNodeFinished(node: WorkflowNodeRunRecord, context: WorkflowNodeLifecycleContext): Promise<void>
  onRunFinished(run: WorkflowRunRecord): Promise<void>
}
