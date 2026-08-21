import type {
  OntologyDefinitionCatalog,
  OntologySource,
  Queues,
  Sixb,
  SixbFailure,
  Storage,
  WorkflowStepOutputs,
} from "@sixb/core"
import type { LoggingService } from "@sixb/core/internal/logging"
import type {
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunExecution,
  WorkflowRunFailureCode,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"

export type WorkflowLogSession = ReturnType<LoggingService["startExecution"]>

export interface WorkflowWorkerContext {
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  readonly storage: Storage
  readonly queues: Queues
  readonly workflowRuns: WorkflowRunStorage
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logging?: LoggingService
}

export interface WorkflowJob {
  readonly id: string
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly execution?: WorkflowRunExecution
}

export interface WorkflowResumeJob {
  readonly id: string
  readonly workflowId: string
  readonly nodeRunId: string
  readonly execution?: WorkflowRunExecution
}

export type WorkflowRunFailureReporter = (
  error: unknown,
  run: WorkflowRunRecord,
  failure: SixbFailure<WorkflowRunFailureCode>
) => void

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
