import type {
  OntologySource,
  Pario,
  ParioRuntimeContext,
  WorkflowDefinition,
  WorkflowNodeRunRecord,
  WorkflowRunRecord,
  WorkflowRunStorage,
  WorkflowStepOutputs,
} from "@pario/core"

export interface WorkflowWorkerContext extends ParioRuntimeContext {
  readonly workflowRuns: WorkflowRunStorage
  readonly pario: Pario<readonly OntologySource[]>
  getWorkflowById(workflowId: string): WorkflowDefinition | null
}

export interface WorkflowWorkerPario extends ParioRuntimeContext {
  readonly id: string
  getWorkflowDefinitions(): readonly WorkflowDefinition[]
  getWorkflowById(workflowId: string): WorkflowDefinition | null
}

export interface WorkflowJob {
  readonly id: string
  readonly workflowId: string
  readonly input?: Readonly<Record<string, unknown>>
}

export interface RunWorkflowJobInput {
  readonly runtime: WorkflowWorkerContext
  readonly job: WorkflowJob
  readonly signal?: AbortSignal
  readonly observer?: WorkflowRunObserver
}

export interface WorkflowRunResult {
  readonly id: string
  readonly workflowId: string
  readonly status: "succeeded"
  readonly run: WorkflowRunRecord
  readonly nodes: readonly WorkflowNodeRunRecord[]
  readonly steps: WorkflowStepOutputs
}

export interface WorkflowNodeLifecycleContext {
  readonly totalNodes: number
}

export interface WorkflowRunObserver {
  onRunStarted(run: WorkflowRunRecord): Promise<void>
  onNodeStarted(node: WorkflowNodeRunRecord, context: WorkflowNodeLifecycleContext): Promise<void>
  onNodeFinished(node: WorkflowNodeRunRecord, context: WorkflowNodeLifecycleContext): Promise<void>
  onRunFinished(run: WorkflowRunRecord): Promise<void>
}
