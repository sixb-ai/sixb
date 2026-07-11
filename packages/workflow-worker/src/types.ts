import type {
  LogsRuntime,
  OntologySource,
  Sixb,
  SixbRuntimeContext,
  WorkflowDefinition,
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunSource,
  WorkflowRunStorage,
  WorkflowStepOutputs,
  WorkflowsRuntime,
} from "@sixb/core"

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

export interface RunWorkflowJobInput {
  readonly runtime: WorkflowWorkerContext
  readonly job: WorkflowJob
  readonly signal?: AbortSignal
  readonly observer?: WorkflowRunObserver
}

export interface RunWorkflowResumeJobInput {
  readonly runtime: WorkflowWorkerContext
  readonly job: WorkflowResumeJob
  readonly signal?: AbortSignal
  readonly observer?: WorkflowRunObserver
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
