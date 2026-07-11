import type {
  ActionBinding,
  ActionDefinition,
  ActionParamsConfig,
  InferActionParams,
} from "../../actions"
import type { LinkToken, ObjectRef, ObjectTypeWithTokens, Property } from "../../ontology"
import type { InferPropertyValue } from "../../ontology/inference"
import type { RuleDefinition } from "../../rules"
import type { ActionRunFailure } from "../../storage"
import type { PropertyChangeOperation } from "../property-changes"
import type {
  DatasetVersionCommittedEvent,
  DomainEvent,
  PipelineRunFinishedEvent,
  SyncRunFinishedEvent,
} from "../types"

declare const eventSelectorContextType: unique symbol

export type ObjectEventSelectorContext<
  TObjectType extends ObjectTypeWithTokens = ObjectTypeWithTokens,
> = {
  readonly kind: "object"
  readonly objectType: TObjectType
}

export type LinkEventSelectorContext<
  TObjectType extends ObjectTypeWithTokens = ObjectTypeWithTokens,
  TLink extends LinkToken<TObjectType["id"]> = LinkToken<TObjectType["id"]>,
> = {
  readonly kind: "link"
  readonly objectType: TObjectType
  readonly link: TLink
}

export type RuleEventSelectorOperation = "triggered" | "resolved"

export type RuleEventSelectorContext<
  TRule extends RuleDefinition = RuleDefinition,
  TOperation extends RuleEventSelectorOperation = RuleEventSelectorOperation,
> = {
  readonly kind: "rule"
  readonly rule: TRule
  readonly operation: TOperation
}

export type ActionEventSelectorOperation = "requested" | "completed" | "failed"

export type ActionEventToken<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
  TBinding extends ActionBinding = ActionBinding,
> = {
  readonly id: TId
  readonly params: TParams
  readonly binding: TBinding
}

export type ActionEventTokenOf<TAction extends ActionDefinition> = ActionEventToken<
  TAction["id"],
  TAction["params"],
  TAction["binding"]
>

export type ActionEventSelectorContext<
  TAction extends ActionEventToken = ActionEventToken,
  TOperation extends ActionEventSelectorOperation = ActionEventSelectorOperation,
> = {
  readonly kind: "action"
  readonly action: TAction
  readonly operation: TOperation
}

export type DatasetEventToken<TId extends string = string> = {
  readonly kind: "dataset"
  readonly id: TId
}

export type SyncEventToken<TId extends string = string> = {
  readonly kind: "sync"
  readonly id: TId
}

export type PipelineEventToken<TId extends string = string> = {
  readonly kind: "pipeline"
  readonly id: TId
}

export type DatasetEventSelectorContext<TDataset extends DatasetEventToken = DatasetEventToken> = {
  readonly kind: "dataset"
  readonly dataset: TDataset
}

export type RunEventSelectorOperation = "succeeded" | "failed" | "cancelled"

export type SyncEventSelectorContext<
  TSync extends SyncEventToken = SyncEventToken,
  TOperation extends RunEventSelectorOperation = RunEventSelectorOperation,
> = {
  readonly kind: "sync"
  readonly sync: TSync
  readonly operation: TOperation
}

export type PipelineEventSelectorContext<
  TPipeline extends PipelineEventToken = PipelineEventToken,
  TOperation extends RunEventSelectorOperation = RunEventSelectorOperation,
> = {
  readonly kind: "pipeline"
  readonly pipeline: TPipeline
  readonly operation: TOperation
}

export type EventSelectorContext =
  | ObjectEventSelectorContext
  | LinkEventSelectorContext
  | RuleEventSelectorContext
  | ActionEventSelectorContext
  | DatasetEventSelectorContext
  | SyncEventSelectorContext
  | PipelineEventSelectorContext

export type InferEventSelectorContext<TSelector> = TSelector extends {
  readonly [eventSelectorContextType]?: infer TContext
}
  ? NonNullable<TContext>
  : EventSelectorContext

export type InferEventSelectorEvent<TSelector> = EventSelectorEvent<
  InferEventSelectorContext<TSelector>
>

export type EventSelectorEvent<TContext> =
  TContext extends ObjectEventSelectorContext<infer TObjectType>
    ? ObjectEventSelectorEvent<TObjectType>
    : TContext extends LinkEventSelectorContext<infer TObjectType, infer TLink>
      ? LinkEventSelectorEvent<TObjectType, TLink>
      : TContext extends RuleEventSelectorContext<infer TRule, infer TOperation>
        ? RuleEventSelectorEvent<TRule, TOperation>
        : TContext extends ActionEventSelectorContext<infer TAction, infer TOperation>
          ? ActionEventSelectorEvent<TAction, TOperation>
          : TContext extends DatasetEventSelectorContext<infer TDataset>
            ? DatasetEventSelectorEvent<TDataset>
            : TContext extends SyncEventSelectorContext<infer TSync, infer TOperation>
              ? SyncEventSelectorEvent<TSync, TOperation>
              : TContext extends PipelineEventSelectorContext<infer TPipeline, infer TOperation>
                ? PipelineEventSelectorEvent<TPipeline, TOperation>
                : never

export interface ObjectEventSelectorEvent<TObjectType extends ObjectTypeWithTokens> {
  readonly object: {
    readonly objectTypeId: TObjectType["id"]
    readonly primaryId: string
    readonly p: ObjectPropertyValues<TObjectType>
  }
}

export interface LinkEventSelectorEvent<
  _TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken,
> {
  readonly source: ObjectRef<TLink["objectTypeId"]>
  readonly target: ObjectRef<ResolveTargetTypeId<TLink["targetObjectTypeId"]>>
  readonly link: {
    readonly id: TLink["id"]
    readonly p: LinkPropertyValues<TLink>
  }
}

export type RuleEventSelectorEvent<
  TRule extends RuleDefinition = RuleDefinition,
  _TOperation extends RuleEventSelectorOperation = RuleEventSelectorOperation,
> = {
  readonly ruleId: TRule["id"]
  readonly subject: ObjectRef<RuleSubjectTypeId<TRule>>
}

export type ActionEventSelectorEvent<
  TAction extends ActionEventToken = ActionEventToken,
  TOperation extends ActionEventSelectorOperation = ActionEventSelectorOperation,
> = {
  readonly actionId: TAction["id"]
  readonly runId: string
} & ActionSubjectEvent<TAction> &
  (TOperation extends "requested"
    ? { readonly params: InferActionParams<TAction["params"]> }
    : TOperation extends "failed"
      ? { readonly error: ActionRunFailure }
      : Record<never, never>)

export type DatasetEventSelectorEvent<TDataset extends DatasetEventToken = DatasetEventToken> =
  Omit<DatasetVersionCommittedEvent["payload"], "datasetId"> & {
    readonly datasetId: TDataset["id"]
  }

export type SyncEventSelectorEvent<
  TSync extends SyncEventToken = SyncEventToken,
  TOperation extends RunEventSelectorOperation = RunEventSelectorOperation,
> = Omit<SyncRunFinishedEvent["payload"], "syncId" | "status"> & {
  readonly syncId: TSync["id"]
  readonly status: TOperation
}

export type PipelineEventSelectorEvent<
  TPipeline extends PipelineEventToken = PipelineEventToken,
  TOperation extends RunEventSelectorOperation = RunEventSelectorOperation,
> = Omit<PipelineRunFinishedEvent["payload"], "pipelineId" | "status"> & {
  readonly pipelineId: TPipeline["id"]
  readonly status: TOperation
}

export interface EventSelectorSpec<TContext = EventSelectorContext> {
  readonly [eventSelectorContextType]?: TContext
  readonly topic?: DomainEvent["topic"]
  readonly types?: readonly DomainEvent["type"][]
  readonly objectTypeId?: string
  readonly primaryId?: string
  readonly propertyId?: string
  readonly propertyOperation?: PropertyChangeOperation
  readonly linkId?: string
  readonly ruleId?: string
  readonly actionId?: string
  readonly datasetId?: string
  readonly syncId?: string
  readonly pipelineId?: string
  readonly runStatus?: RunEventSelectorOperation
  readonly runId?: string
}

type ObjectPropertyValues<TObjectType extends ObjectTypeWithTokens> = {
  readonly [TProperty in TObjectType["properties"][number] as TProperty["id"]]: InferPropertyValue<TProperty>
}

type LinkPropertyValues<TLink extends LinkToken> =
  NonNullable<TLink["link"]["properties"]> extends readonly Property[]
    ? {
        readonly [TProperty in NonNullable<
          TLink["link"]["properties"]
        >[number] as TProperty["id"]]: InferPropertyValue<TProperty>
      }
    : Record<never, never>

type ResolveTargetTypeId<TTarget> = TTarget extends readonly string[]
  ? TTarget[number]
  : TTarget extends string
    ? TTarget
    : string

type RuleSubjectTypeId<TRule extends RuleDefinition> =
  TRule extends RuleDefinition<string, infer TObjectType> ? TObjectType["id"] : string

type ActionSubjectEvent<TAction extends ActionEventToken> = TAction["binding"] extends {
  readonly kind: "object"
  readonly objectType: infer TObjectType extends { readonly id: string }
}
  ? { readonly subject: ObjectRef<TObjectType["id"]> }
  : Record<never, never>
