import type {
  OntologySource,
  Pario,
  ParioRuntimeContext,
  WorkflowDefinition,
  WorkflowInterventionRecord,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
  WorkflowStepOutputs,
  WorkflowsRuntime,
} from "@pario/core"

export interface WorkflowWorkerContext extends ParioRuntimeContext {
  readonly workflowRuns: WorkflowRunStorage
  readonly pario: Pario<readonly OntologySource[]>
  getWorkflowById(workflowId: string): WorkflowDefinition | null
}

export interface WorkflowWorkerPario extends ParioRuntimeContext {
  readonly id: string
  readonly workflows: WorkflowsRuntime
}

export interface WorkflowJob {
  readonly id: string
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
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
  readonly status: "succeeded" | "waiting"
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
