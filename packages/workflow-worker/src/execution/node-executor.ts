import type {
  ValueType,
  WorkflowDefinition,
  WorkflowInterventionRecord,
  WorkflowIOSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeRunRecord,
  WorkflowStepOutputs,
} from "@sixb/core"
import type { WorkflowJob, WorkflowWorkerContext } from "../types"

export interface WorkflowExecutionState {
  readonly workflowInput: Readonly<Record<string, unknown>>
  current: Readonly<Record<string, unknown>>
  readonly steps: WorkflowStepOutputs
}

export interface WorkflowNodeExecutionContext {
  readonly runtime: WorkflowWorkerContext
  readonly workflow: WorkflowDefinition
  readonly job: WorkflowJob
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  readonly signal: AbortSignal
  readonly state: WorkflowExecutionState
  markSideEffectBoundaryPassed(): void
}

export interface PreparedWorkflowNode {
  readonly input: unknown
  readonly inputSnapshot: WorkflowIOSnapshot
}

export interface WorkflowNodeStatePatch {
  readonly current?: Readonly<Record<string, unknown>>
  readonly steps?: WorkflowStepOutputs
}

export type WorkflowNodeOutcome =
  | {
      readonly status?: "succeeded"
      readonly outputSnapshot?: WorkflowIOSnapshot
      readonly statePatch?: WorkflowNodeStatePatch
    }
  | {
      readonly status: "waiting"
      readonly intervention: WorkflowInterventionRecord
    }

export interface WorkflowNodePrepareInput<TNode extends WorkflowNodeDefinition> {
  readonly node: TNode
  readonly context: WorkflowNodeExecutionContext
}

export interface WorkflowNodeExecuteInput<TNode extends WorkflowNodeDefinition> {
  readonly node: TNode
  readonly nodeIndex: number
  readonly nodeRun: WorkflowNodeRunRecord
  readonly prepared: PreparedWorkflowNode
  readonly context: WorkflowNodeExecutionContext
}

export interface WorkflowNodeExecutor<
  TNode extends WorkflowNodeDefinition = WorkflowNodeDefinition,
> {
  readonly type: TNode["type"]
  prepare(
    input: WorkflowNodePrepareInput<TNode>
  ): PreparedWorkflowNode | Promise<PreparedWorkflowNode>
  execute(
    input: WorkflowNodeExecuteInput<TNode>
  ): WorkflowNodeOutcome | Promise<WorkflowNodeOutcome>
}

export type WorkflowNodeExecutorRegistry = {
  readonly [TType in WorkflowNodeDefinition["type"]]: WorkflowNodeExecutor<
    Extract<WorkflowNodeDefinition, { type: TType }>
  >
}
