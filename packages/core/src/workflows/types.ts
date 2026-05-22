import type { ActionParamsConfig, InferActionParams } from "../actions"
import type { JsonValue } from "../json"
import type { InferSchemaOrRef, ObjectRef, SchemaOrRef } from "../ontology"
import type { Pario } from "../runtime/pario"
import type { OntologySource } from "../runtime/types"
import type { ScheduleDefinition } from "../schedules"

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Append<TValues extends readonly unknown[], TValue> = [...TValues, TValue]
type SchemaOrRefInput<TShape extends Record<string, unknown>> = {
  readonly [K in keyof TShape]: TShape[K] extends SchemaOrRef ? TShape[K] : never
}
type InferSchemaOrRefRecord<TShape extends Record<string, unknown>> = Simplify<{
  [K in keyof TShape]: TShape[K] extends SchemaOrRef ? InferSchemaOrRef<TShape[K]> : never
}>
type WordSeparator = "-" | "_" | "." | " "
declare const stepInputValueType: unique symbol
declare const stepOutputValueType: unique symbol

export type DerivedWorkflowNodeKey<TId extends string> = string extends TId
  ? string
  : TId extends `${infer Head}${WordSeparator}${infer Tail}`
    ? `${Uncapitalize<Head>}${Capitalize<DerivedWorkflowNodeKey<Tail>>}`
    : Uncapitalize<TId>

export interface StepRunContext<TInput extends Record<string, unknown>> {
  readonly input: TInput
  readonly pario: Pario<readonly OntologySource[]>
}

export type StepHandler<
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> = {
  bivarianceHack(ctx: StepRunContext<TInput>): TOutput | Promise<TOutput>
}["bivarianceHack"]

export interface StepDefinition<
  TId extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
  TInputValue extends Record<string, unknown> = Record<string, unknown>,
  TOutputValue extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "step"
  readonly id: TId
  readonly input: TInput
  readonly output: TOutput
  readonly handler: StepHandler<Record<string, unknown>, Record<string, unknown>>
  readonly [stepInputValueType]?: TInputValue
  readonly [stepOutputValueType]?: TOutputValue
}

export interface StepRunBuilder<
  TId extends string,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> {
  run(
    handler: StepHandler<InferSchemaOrRefRecord<TInput>, InferSchemaOrRefRecord<TOutput>>
  ): StepDefinition<
    TId,
    TInput,
    TOutput,
    InferSchemaOrRefRecord<TInput>,
    InferSchemaOrRefRecord<TOutput>
  >
}

export interface StepOutputBuilder<TId extends string, TInput extends Record<string, unknown>> {
  output<const TOutput extends Record<string, unknown>>(
    output: TOutput & SchemaOrRefInput<TOutput>
  ): StepRunBuilder<TId, TInput, TOutput>
}

export interface StepBuilder<TId extends string> {
  input<const TInput extends Record<string, unknown>>(
    input: TInput & SchemaOrRefInput<TInput>
  ): StepOutputBuilder<TId, TInput>
}

export type WorkflowTriggerDefinition = {
  readonly type: "schedule"
  readonly scheduleId: string
}

export type InferStepInput<TStep extends StepDefinition> = TStep extends {
  readonly [stepInputValueType]?: infer TInputValue
}
  ? NonNullable<TInputValue>
  : never
export type InferStepOutput<TStep extends StepDefinition> = TStep extends {
  readonly [stepOutputValueType]?: infer TOutputValue
}
  ? NonNullable<TOutputValue>
  : never

export type WorkflowStepOutputs = Record<string, Record<string, unknown>>
export type WorkflowIOSnapshot = Readonly<Record<string, JsonValue>>

export interface WorkflowMapperContext<
  TInput extends Record<string, unknown>,
  TSteps extends WorkflowStepOutputs,
> {
  readonly input: TInput
  readonly steps: TSteps
}

export type WorkflowStepMapper<
  TInput extends Record<string, unknown>,
  TSteps extends WorkflowStepOutputs,
  TStepInput extends Record<string, unknown>,
> = (ctx: WorkflowMapperContext<TInput, TSteps>) => TStepInput

export interface WorkflowActionDefinition<
  TId extends string = string,
  TTargetId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> {
  readonly kind: "action"
  readonly id: TId
  readonly target: { readonly id: TTargetId }
  readonly params: TParams
}

export type WorkflowActionMapperResult<TAction extends WorkflowActionDefinition> = {
  readonly target: ObjectRef<TAction["target"]["id"]>
  readonly params: InferActionParams<TAction["params"]>
}

export type WorkflowActionMapper<
  TInput extends Record<string, unknown>,
  TSteps extends WorkflowStepOutputs,
  TAction extends WorkflowActionDefinition,
  TResult extends WorkflowActionMapperResult<TAction> = WorkflowActionMapperResult<TAction>,
> = (ctx: WorkflowMapperContext<TInput, TSteps>) => TResult

export interface WorkflowStepNodeDefinition<
  TStep extends StepDefinition = StepDefinition,
  TMapper = unknown,
> {
  readonly type: "step"
  readonly id: TStep["id"]
  readonly key: DerivedWorkflowNodeKey<TStep["id"]>
  readonly step: TStep
  readonly mapper?: TMapper
}

export interface WorkflowActionNodeDefinition<
  TAction extends WorkflowActionDefinition = WorkflowActionDefinition,
  TMapper = unknown,
> {
  readonly type: "action"
  readonly id: TAction["id"]
  readonly key: DerivedWorkflowNodeKey<TAction["id"]>
  readonly action: TAction
  readonly mapper: TMapper
}

export type WorkflowNodeDefinition = WorkflowStepNodeDefinition | WorkflowActionNodeDefinition

type AddStepOutput<TSteps extends WorkflowStepOutputs, TStep extends StepDefinition> = Simplify<
  TSteps & {
    [K in DerivedWorkflowNodeKey<TStep["id"]>]: InferStepOutput<TStep>
  }
>

type DirectDataflowGuard<TCurrent extends Record<string, unknown>, TStep extends StepDefinition> =
  TCurrent extends InferStepInput<TStep> ? unknown : never

export interface WorkflowDefinition<
  TId extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TNodes extends readonly WorkflowNodeDefinition[] = readonly WorkflowNodeDefinition[],
> {
  readonly kind: "workflow"
  readonly id: TId
  readonly input: TInput
  readonly triggers: readonly WorkflowTriggerDefinition[]
  readonly nodes: TNodes
}

export type InferWorkflowInput<TWorkflow extends WorkflowDefinition> =
  TWorkflow extends WorkflowDefinition<string, infer TInput, readonly WorkflowNodeDefinition[]>
    ? InferSchemaOrRefRecord<TInput>
    : never

export interface WorkflowChainDefinition<
  TId extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TNodes extends readonly WorkflowNodeDefinition[] = readonly WorkflowNodeDefinition[],
  TCurrent extends Record<string, unknown> = InferSchemaOrRefRecord<TInput>,
  TSteps extends WorkflowStepOutputs = WorkflowStepOutputs,
> extends WorkflowDefinition<TId, TInput, TNodes> {
  then<const TStep extends StepDefinition>(
    step: TStep & DirectDataflowGuard<TCurrent, TStep>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<TNodes, WorkflowStepNodeDefinition<TStep, undefined>>,
    InferStepOutput<TStep>,
    AddStepOutput<TSteps, TStep>
  >
  then<const TStep extends StepDefinition>(
    step: TStep,
    mapper: WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferStepInput<TStep>>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<
      TNodes,
      WorkflowStepNodeDefinition<
        TStep,
        WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferStepInput<TStep>>
      >
    >,
    InferStepOutput<TStep>,
    AddStepOutput<TSteps, TStep>
  >
  then<
    const TAction extends WorkflowActionDefinition,
    const TResult extends WorkflowActionMapperResult<TAction>,
  >(
    action: TAction,
    mapper: WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction, TResult>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<
      TNodes,
      WorkflowActionNodeDefinition<
        TAction,
        WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction, TResult>
      >
    >,
    TCurrent,
    TSteps
  >
}

export interface WorkflowDraftBuilder<
  TId extends string,
  TInput extends Record<string, unknown>,
  TCurrent extends Record<string, unknown> = InferSchemaOrRefRecord<TInput>,
  TSteps extends WorkflowStepOutputs = Record<never, never>,
> {
  when(schedule: ScheduleDefinition): WorkflowDraftBuilder<TId, TInput, TCurrent, TSteps>
  then<const TStep extends StepDefinition>(
    step: TStep & DirectDataflowGuard<TCurrent, TStep>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [WorkflowStepNodeDefinition<TStep, undefined>],
    InferStepOutput<TStep>,
    AddStepOutput<TSteps, TStep>
  >
  then<const TStep extends StepDefinition>(
    step: TStep,
    mapper: WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferStepInput<TStep>>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [
      WorkflowStepNodeDefinition<
        TStep,
        WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferStepInput<TStep>>
      >,
    ],
    InferStepOutput<TStep>,
    AddStepOutput<TSteps, TStep>
  >
  then<
    const TAction extends WorkflowActionDefinition,
    const TResult extends WorkflowActionMapperResult<TAction>,
  >(
    action: TAction,
    mapper: WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction, TResult>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [
      WorkflowActionNodeDefinition<
        TAction,
        WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction, TResult>
      >,
    ],
    TCurrent,
    TSteps
  >
}

export interface WorkflowBuilder<TId extends string> {
  input<const TInput extends Record<string, unknown>>(
    input: TInput & SchemaOrRefInput<TInput>
  ): WorkflowDraftBuilder<TId, TInput>
}
