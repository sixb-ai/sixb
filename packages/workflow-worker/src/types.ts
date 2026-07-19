import type {
  OntologySource,
  Sixb,
  SixbRuntimeContext,
  WorkflowDefinition,
  WorkflowRunSource,
  WorkflowStepOutputs,
} from "@sixb/core"
import type { LogsRuntime } from "@sixb/core/internal/logging"
import type { WorkflowsRuntime } from "@sixb/core/internal/workflows"
import type {
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
} from "@sixb/core/storage"

export type WorkflowLogSession = ReturnType<LogsRuntime["startExecution"]>

export interface WorkflowWorkerContext extends SixbRuntimeContext {
  readonly workflowRuns: WorkflowRunStorage
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logs?: LogsRuntime
  getWorkflowById(workflowId: string): WorkflowDefinition | null
}

export interface WorkflowWorkerSixb extends SixbRuntimeContext {
  readonly id: string
  readonly workflows: WorkflowsRuntime
  readonly logs?: LogsRuntime
}

export interface WorkflowJob {
  readonly id: string
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
  readonly source?: WorkflowRunSource
}

export interface WorkflowResumeJob {
  readonly id: string
  readonly workflowId: string
  readonly pendingInterventionId: string
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
