import type {
  ActionDefinition,
  GlobalActionDefinition,
  InferActionParams,
  ObjectActionDefinition,
} from "../actions"
import type { ActionsRuntime } from "../actions/execution"
import type { AgentsRuntime } from "../agents/execution"
import type { AgentDefinition } from "../agents/types"
import type { Principal } from "../auth"
import type { BlobsRuntime } from "../blob-storage/execution"
import type { ConnectorRuntime } from "../connectors/execution"
import type { DatasetsRuntime } from "../datasets/execution"
import type { EventsRuntime } from "../events/execution"
import type { JsonValue } from "../json"
import type { Logger } from "../logging"
import type { LogsRuntime } from "../logging/execution"
import type { ObjectsRuntime } from "../objects/execution"
import type { InferSchemaOrRef, ObjectRef, OntologySource, SchemaOrRef } from "../ontology"
import type { PipelinesRuntime } from "../pipelines/execution"
import type { ProjectionsRuntime } from "../projections/execution"
import type { RulesRuntime } from "../rules/execution"
import type { ScheduleDefinition, ScheduleDefinitionForEvent } from "../schedules"
import type { SchedulesRuntime } from "../schedules/execution"
import type { SyncsRuntime } from "../syncs/execution"
import type { WorkflowsRuntime } from "./execution"

type Simplify<T> = { [K in keyof T]: T[K] } & {}
type Append<TValues extends readonly unknown[], TValue> = [...TValues, TValue]
type SchemaOrRefInput<TShape extends Record<string, unknown>> = {
  readonly [K in keyof TShape]: TShape[K] extends SchemaOrRef ? TShape[K] : never
}
type InferSchemaOrRefRecord<TShape extends Record<string, unknown>> = Simplify<{
  -readonly [K in keyof TShape]: TShape[K] extends SchemaOrRef ? InferSchemaOrRef<TShape[K]> : never
}>
type WordSeparator = "-" | "_" | "." | " "
declare const stepInputValueType: unique symbol
declare const stepOutputValueType: unique symbol
declare const agentStepInputValueType: unique symbol
declare const agentStepOutputValueType: unique symbol
declare const interventionInputValueType: unique symbol
declare const interventionResponseValueType: unique symbol

export type DerivedWorkflowNodeKey<TId extends string> = string extends TId
  ? string
  : TId extends `${infer Head}${WordSeparator}${infer Tail}`
    ? `${Uncapitalize<Head>}${Capitalize<DerivedWorkflowNodeKey<Tail>>}`
    : Uncapitalize<TId>

export interface StepRunContext<TInput extends Record<string, unknown>> {
  readonly input: TInput
  readonly sixb: WorkflowRuntimeFacade
  readonly logger: Logger
}

/**
 * Structural view of the public `Sixb` SDK used to close the recursive workflow-definition type.
 * It is a type-level cycle break, not a separate runtime or compatibility surface.
 */
export interface WorkflowRuntimeFacade {
  readonly objects: ObjectsRuntime<readonly OntologySource[]>
  readonly actions: ActionsRuntime
  readonly agents: AgentsRuntime
  readonly datasets: DatasetsRuntime
  readonly workflows: WorkflowsRuntime
  readonly syncs: SyncsRuntime
  readonly pipelines: PipelinesRuntime
  readonly projections: ProjectionsRuntime
  readonly rules: RulesRuntime
  readonly events: EventsRuntime
  readonly logs: LogsRuntime
  readonly schedules: SchedulesRuntime
  readonly connector: ConnectorRuntime
  readonly blobs: BlobsRuntime
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

export interface AgentStepPromptContext<TInput extends Record<string, unknown>> {
  readonly input: TInput
}

export type AgentStepPrompt<TInput extends Record<string, unknown>> = (
  ctx: AgentStepPromptContext<TInput>
) => string | Promise<string>

export interface AgentStepDefinition<
  TId extends string = string,
  TAgent extends AgentDefinition = AgentDefinition,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = Record<string, unknown>,
  TInputValue extends Record<string, unknown> = Record<string, unknown>,
  TOutputValue extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "agentStep"
  readonly id: TId
  readonly agent: TAgent
  readonly input: TInput
  readonly output: TOutput
  readonly prompt: AgentStepPrompt<Record<string, unknown>>
  readonly [agentStepInputValueType]?: TInputValue
  readonly [agentStepOutputValueType]?: TOutputValue
}

export interface AgentStepPromptBuilder<
  TId extends string,
  TAgent extends AgentDefinition,
  TInput extends Record<string, unknown>,
  TOutput extends Record<string, unknown>,
> {
  prompt(
    prompt: AgentStepPrompt<InferSchemaOrRefRecord<TInput>>
  ): AgentStepDefinition<
    TId,
    TAgent,
    TInput,
    TOutput,
    InferSchemaOrRefRecord<TInput>,
    InferSchemaOrRefRecord<TOutput>
  >
}

export interface AgentStepOutputBuilder<
  TId extends string,
  TAgent extends AgentDefinition,
  TInput extends Record<string, unknown>,
> {
  output<const TOutput extends Record<string, unknown>>(
    output: TOutput & SchemaOrRefInput<TOutput>
  ): AgentStepPromptBuilder<TId, TAgent, TInput, TOutput>
}

export interface AgentStepBuilder<TId extends string, TAgent extends AgentDefinition> {
  input<const TInput extends Record<string, unknown>>(
    input: TInput & SchemaOrRefInput<TInput>
  ): AgentStepOutputBuilder<TId, TAgent, TInput>
}

export type InferAgentStepInput<TStep extends AgentStepDefinition> = TStep extends {
  readonly [agentStepInputValueType]?: infer TInputValue
}
  ? NonNullable<TInputValue>
  : never

export type InferAgentStepOutput<TStep extends AgentStepDefinition> = TStep extends {
  readonly [agentStepOutputValueType]?: infer TOutputValue
}
  ? NonNullable<TOutputValue>
  : never

export type WorkflowScheduleMapper<
  TEvent = unknown,
  TInput extends Record<string, unknown> = Record<string, unknown>,
> = (context: { readonly event: TEvent }) => TInput

export type WorkflowScheduleTriggerDefinition<
  TMapper extends ((...args: never[]) => unknown) | undefined =
    | ((...args: never[]) => unknown)
    | undefined,
> = {
  readonly type: "schedule"
  readonly scheduleId: string
  readonly mapper?: TMapper
}

export type WorkflowTriggerDefinition = WorkflowScheduleTriggerDefinition

/**
 * Origin of a workflow run request.
 *
 * Captured on the queued run record and emitted with `workflow.run.queued`
 * so downstream consumers can trace why a run started. Intentionally minimal
 * for now — additional sources (schedule, sync, pipeline, ...) can be added
 * when the triggers that produce them land.
 */
export type WorkflowRunSource =
  | { readonly type: "manual" }
  | {
      readonly type: "webhook"
      readonly connectorId: string
      readonly webhookId: string
      readonly deliveryId?: string
    }
  | {
      readonly type: "schedule"
      readonly scheduleId: string
      readonly eventId: string
      readonly principal: Principal
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
export type InferWorkflowContract<TShape extends Record<string, unknown>> =
  InferSchemaOrRefRecord<TShape>

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

export interface InterventionFieldConfig<
  TSchema extends SchemaOrRef = SchemaOrRef,
  TRequired extends boolean = boolean,
> {
  readonly schema: TSchema
  readonly required?: TRequired
  readonly description?: string
}

export type InterventionResponseField = SchemaOrRef | InterventionFieldConfig
export type InterventionResponseConfig = Record<string, InterventionResponseField>
type InterventionResponseInput<TShape extends Record<string, unknown>> = {
  readonly [K in keyof TShape]: TShape[K] extends InterventionResponseField ? TShape[K] : never
}

type InterventionResponseSchema<TField extends InterventionResponseField> =
  TField extends InterventionFieldConfig<infer TSchema, boolean> ? TSchema : TField

type RequiredInterventionResponseKeys<TResponse extends InterventionResponseConfig> = {
  [K in keyof TResponse]-?: TResponse[K] extends InterventionFieldConfig<
    SchemaOrRef,
    infer TRequired
  >
    ? TRequired extends false
      ? never
      : K
    : K
}[keyof TResponse]

type OptionalInterventionResponseKeys<TResponse extends InterventionResponseConfig> = Exclude<
  keyof TResponse,
  RequiredInterventionResponseKeys<TResponse>
>

type InferInterventionResponseRecord<TResponse extends InterventionResponseConfig> = Simplify<
  {
    [K in RequiredInterventionResponseKeys<TResponse>]: InferSchemaOrRef<
      InterventionResponseSchema<TResponse[K]>
    >
  } & {
    [K in OptionalInterventionResponseKeys<TResponse>]?: InferSchemaOrRef<
      InterventionResponseSchema<TResponse[K]>
    >
  }
>

export type InterventionDefaultsHandler<
  TInput extends Record<string, unknown>,
  TResponse extends InterventionResponseConfig,
> = (ctx: {
  readonly input: InferWorkflowContract<TInput>
  readonly workflowInput: Readonly<Record<string, unknown>>
  readonly steps: Readonly<Record<string, Record<string, unknown>>>
}) =>
  | Partial<InferInterventionResponseRecord<TResponse>>
  | Promise<Partial<InferInterventionResponseRecord<TResponse>>>

export type InterventionDefaultsRuntimeHandler = (ctx: {
  readonly input: Readonly<Record<string, unknown>>
  readonly workflowInput: Readonly<Record<string, unknown>>
  readonly steps: Readonly<Record<string, Record<string, unknown>>>
}) => Partial<Record<string, unknown>> | Promise<Partial<Record<string, unknown>>>

export interface InterventionDefinition<
  TId extends string = string,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TResponse extends InterventionResponseConfig = InterventionResponseConfig,
  TInputValue extends Record<string, unknown> = Record<string, unknown>,
  TResponseValue extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: "intervention"
  readonly id: TId
  readonly description?: string
  readonly input: TInput
  readonly response: TResponse
  readonly defaults?: InterventionDefaultsRuntimeHandler
  readonly [interventionInputValueType]?: TInputValue
  readonly [interventionResponseValueType]?: TResponseValue
}

type InterventionDefaultsBuilderMethod<
  TId extends string,
  TInput extends Record<string, unknown>,
  TResponse extends InterventionResponseConfig,
  TInputValue extends Record<string, unknown>,
  TResponseValue extends Record<string, unknown>,
> = InterventionDefaultsRuntimeHandler &
  ((
    handler: InterventionDefaultsHandler<TInput, TResponse>
  ) => InterventionDefinition<TId, TInput, TResponse, TInputValue, TResponseValue>)

export type InterventionResponseBuilder<
  TId extends string,
  TInput extends Record<string, unknown>,
  TResponse extends InterventionResponseConfig,
  TInputValue extends Record<string, unknown>,
  TResponseValue extends Record<string, unknown>,
> = Omit<
  InterventionDefinition<TId, TInput, TResponse, TInputValue, TResponseValue>,
  "defaults"
> & {
  readonly defaults: InterventionDefaultsBuilderMethod<
    TId,
    TInput,
    TResponse,
    TInputValue,
    TResponseValue
  >
}

export interface InterventionResponseDraftBuilder<
  TId extends string,
  TInput extends Record<string, unknown>,
> {
  response<const TResponse extends InterventionResponseConfig>(
    response: TResponse & InterventionResponseInput<TResponse>
  ): InterventionResponseBuilder<
    TId,
    TInput,
    TResponse,
    InferWorkflowContract<TInput>,
    InferInterventionResponseRecord<TResponse>
  >
}

export interface InterventionBuilder<TId extends string> {
  input<const TInput extends Record<string, unknown>>(
    input: TInput & SchemaOrRefInput<TInput>
  ): InterventionResponseDraftBuilder<TId, TInput>
}

export type InferInterventionInput<TIntervention extends InterventionDefinition> =
  TIntervention extends {
    readonly [interventionInputValueType]?: infer TInputValue
  }
    ? NonNullable<TInputValue>
    : never

export type InferInterventionResponse<TIntervention extends InterventionDefinition> =
  TIntervention extends {
    readonly [interventionResponseValueType]?: infer TResponseValue
  }
    ? NonNullable<TResponseValue>
    : never

export type WorkflowActionDefinition = ActionDefinition

export type WorkflowActionMapperResult<TAction extends WorkflowActionDefinition> =
  TAction extends ObjectActionDefinition
    ? {
        readonly subject: ObjectRef<TAction["binding"]["objectType"]["id"]>
        readonly params: InferActionParams<TAction["params"]>
      }
    : TAction extends GlobalActionDefinition
      ? {
          readonly subject?: never
          readonly params: InferActionParams<TAction["params"]>
        }
      : never

export type WorkflowActionMapper<
  TInput extends Record<string, unknown>,
  TSteps extends WorkflowStepOutputs,
  TAction extends WorkflowActionDefinition,
> = (ctx: WorkflowMapperContext<TInput, TSteps>) => WorkflowActionMapperResult<TAction>

type DirectObjectActionInput<TAction extends ObjectActionDefinition> =
  "subject" extends keyof InferActionParams<TAction["params"]>
    ? never
    : Simplify<
        {
          readonly subject: ObjectRef<TAction["binding"]["objectType"]["id"]>
        } & InferActionParams<TAction["params"]>
      >

type DirectActionDataflowGuard<
  TCurrent extends Record<string, unknown>,
  TAction extends WorkflowActionDefinition,
> = TAction extends GlobalActionDefinition
  ? TCurrent extends InferActionParams<TAction["params"]>
    ? unknown
    : never
  : TAction extends ObjectActionDefinition
    ? TCurrent extends DirectObjectActionInput<TAction>
      ? unknown
      : never
    : never

type EmptyWorkflowInputGuard<TInput extends Record<string, unknown>> = keyof TInput extends never
  ? unknown
  : never

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
  readonly mapper?: TMapper
}

export interface WorkflowInterventionNodeDefinition<
  TIntervention extends InterventionDefinition = InterventionDefinition,
  TMapper = unknown,
> {
  readonly type: "intervention"
  readonly id: TIntervention["id"]
  readonly key: DerivedWorkflowNodeKey<TIntervention["id"]>
  readonly intervention: TIntervention
  readonly mapper?: TMapper
}

export interface WorkflowAgentNodeDefinition<
  TAgentStep extends AgentStepDefinition = AgentStepDefinition,
  TMapper = unknown,
> {
  readonly type: "agent"
  readonly id: TAgentStep["id"]
  readonly key: DerivedWorkflowNodeKey<TAgentStep["id"]>
  readonly agentStep: TAgentStep
  readonly mapper?: TMapper
}

export type WorkflowNodeDefinition =
  | WorkflowStepNodeDefinition
  | WorkflowActionNodeDefinition
  | WorkflowInterventionNodeDefinition
  | WorkflowAgentNodeDefinition

type AddStepOutput<TSteps extends WorkflowStepOutputs, TStep extends StepDefinition> = Simplify<
  TSteps & {
    [K in DerivedWorkflowNodeKey<TStep["id"]>]: InferStepOutput<TStep>
  }
>

type AddInterventionOutput<
  TSteps extends WorkflowStepOutputs,
  TIntervention extends InterventionDefinition,
> = Simplify<
  TSteps & {
    [K in DerivedWorkflowNodeKey<TIntervention["id"]>]: InferInterventionResponse<TIntervention>
  }
>

type AddAgentStepOutput<
  TSteps extends WorkflowStepOutputs,
  TAgentStep extends AgentStepDefinition,
> = Simplify<
  TSteps & {
    [K in DerivedWorkflowNodeKey<TAgentStep["id"]>]: InferAgentStepOutput<TAgentStep>
  }
>

type DirectDataflowGuard<TCurrent extends Record<string, unknown>, TStep extends StepDefinition> =
  TCurrent extends InferStepInput<TStep> ? unknown : never

type DirectInterventionDataflowGuard<
  TCurrent extends Record<string, unknown>,
  TIntervention extends InterventionDefinition,
> = TCurrent extends InferInterventionInput<TIntervention> ? unknown : never

type DirectAgentStepDataflowGuard<
  TCurrent extends Record<string, unknown>,
  TAgentStep extends AgentStepDefinition,
> = TCurrent extends InferAgentStepInput<TAgentStep> ? unknown : never

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
  then<const TAgentStep extends AgentStepDefinition>(
    agentStep: TAgentStep & DirectAgentStepDataflowGuard<TCurrent, TAgentStep>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<TNodes, WorkflowAgentNodeDefinition<TAgentStep, undefined>>,
    InferAgentStepOutput<TAgentStep>,
    AddAgentStepOutput<TSteps, TAgentStep>
  >
  then<const TAgentStep extends AgentStepDefinition>(
    agentStep: TAgentStep,
    mapper: WorkflowStepMapper<
      InferSchemaOrRefRecord<TInput>,
      TSteps,
      InferAgentStepInput<TAgentStep>
    >
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<
      TNodes,
      WorkflowAgentNodeDefinition<
        TAgentStep,
        WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferAgentStepInput<TAgentStep>>
      >
    >,
    InferAgentStepOutput<TAgentStep>,
    AddAgentStepOutput<TSteps, TAgentStep>
  >
  then<const TIntervention extends InterventionDefinition>(
    intervention: TIntervention & DirectInterventionDataflowGuard<TCurrent, TIntervention>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<TNodes, WorkflowInterventionNodeDefinition<TIntervention, undefined>>,
    InferInterventionResponse<TIntervention>,
    AddInterventionOutput<TSteps, TIntervention>
  >
  then<const TIntervention extends InterventionDefinition>(
    intervention: TIntervention,
    mapper: WorkflowStepMapper<
      InferSchemaOrRefRecord<TInput>,
      TSteps,
      InferInterventionInput<TIntervention>
    >
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<
      TNodes,
      WorkflowInterventionNodeDefinition<
        TIntervention,
        WorkflowStepMapper<
          InferSchemaOrRefRecord<TInput>,
          TSteps,
          InferInterventionInput<TIntervention>
        >
      >
    >,
    InferInterventionResponse<TIntervention>,
    AddInterventionOutput<TSteps, TIntervention>
  >
  then<const TAction extends WorkflowActionDefinition>(
    action: TAction & DirectActionDataflowGuard<TCurrent, TAction>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<TNodes, WorkflowActionNodeDefinition<TAction, undefined>>,
    TCurrent,
    TSteps
  >
  then<const TAction extends WorkflowActionDefinition>(
    action: TAction,
    mapper: WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    Append<
      TNodes,
      WorkflowActionNodeDefinition<
        TAction,
        WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction>
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
  when(
    schedule: ScheduleDefinition & EmptyWorkflowInputGuard<TInput>
  ): WorkflowDraftBuilder<TId, TInput, TCurrent, TSteps>
  when<const TEvent>(
    schedule: ScheduleDefinitionForEvent<TEvent>,
    mapper: WorkflowScheduleMapper<TEvent, InferSchemaOrRefRecord<TInput>>
  ): WorkflowDraftBuilder<TId, TInput, TCurrent, TSteps>
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
  then<const TAgentStep extends AgentStepDefinition>(
    agentStep: TAgentStep & DirectAgentStepDataflowGuard<TCurrent, TAgentStep>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [WorkflowAgentNodeDefinition<TAgentStep, undefined>],
    InferAgentStepOutput<TAgentStep>,
    AddAgentStepOutput<TSteps, TAgentStep>
  >
  then<const TAgentStep extends AgentStepDefinition>(
    agentStep: TAgentStep,
    mapper: WorkflowStepMapper<
      InferSchemaOrRefRecord<TInput>,
      TSteps,
      InferAgentStepInput<TAgentStep>
    >
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [
      WorkflowAgentNodeDefinition<
        TAgentStep,
        WorkflowStepMapper<InferSchemaOrRefRecord<TInput>, TSteps, InferAgentStepInput<TAgentStep>>
      >,
    ],
    InferAgentStepOutput<TAgentStep>,
    AddAgentStepOutput<TSteps, TAgentStep>
  >
  then<const TIntervention extends InterventionDefinition>(
    intervention: TIntervention & DirectInterventionDataflowGuard<TCurrent, TIntervention>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [WorkflowInterventionNodeDefinition<TIntervention, undefined>],
    InferInterventionResponse<TIntervention>,
    AddInterventionOutput<TSteps, TIntervention>
  >
  then<const TIntervention extends InterventionDefinition>(
    intervention: TIntervention,
    mapper: WorkflowStepMapper<
      InferSchemaOrRefRecord<TInput>,
      TSteps,
      InferInterventionInput<TIntervention>
    >
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [
      WorkflowInterventionNodeDefinition<
        TIntervention,
        WorkflowStepMapper<
          InferSchemaOrRefRecord<TInput>,
          TSteps,
          InferInterventionInput<TIntervention>
        >
      >,
    ],
    InferInterventionResponse<TIntervention>,
    AddInterventionOutput<TSteps, TIntervention>
  >
  then<const TAction extends WorkflowActionDefinition>(
    action: TAction & DirectActionDataflowGuard<TCurrent, TAction>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [WorkflowActionNodeDefinition<TAction, undefined>],
    TCurrent,
    TSteps
  >
  then<const TAction extends WorkflowActionDefinition>(
    action: TAction,
    mapper: WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction>
  ): WorkflowChainDefinition<
    TId,
    TInput,
    [
      WorkflowActionNodeDefinition<
        TAction,
        WorkflowActionMapper<InferSchemaOrRefRecord<TInput>, TSteps, TAction>
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
