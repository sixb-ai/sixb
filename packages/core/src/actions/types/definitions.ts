import type { ReadonlyJsonValue } from "../../json"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type {
  ActionEditsHandler,
  ActionEffectsHandler,
  ActionNoResultHandlerResult,
  ActionValidator,
  ActionWritebackHandler,
  ActionWritebackValue,
  GlobalActionEditsHandler,
  GlobalActionEffectsHandler,
  GlobalActionValidator,
  GlobalActionWritebackHandler,
} from "./handlers"
import type { ActionParamsConfig, InferActionParams } from "./params"

// Validate fields structurally so JSON-shaped interfaces do not need an index signature.
// Builders infer the original result first, then check it without widening via NoInfer.
type WritebackJsonValue<T> = T extends ReadonlyJsonValue
  ? T
  : T extends (...args: never[]) => unknown
    ? never
    : T extends object
      ? { [K in keyof T]: WritebackJsonValue<T[K]> }
      : never

type WritebackResult<T> = T extends ReturnType<() => void> ? T : WritebackJsonValue<T>

export interface BaseActionDefinition<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> {
  readonly kind: "action"
  readonly id: TId
  readonly params: TParams
  readonly description?: string
}

export interface GlobalActionPhaseDefinitions<TWriteback = unknown> {
  readonly validate: readonly GlobalActionValidator<Record<string, unknown>>[]
  readonly writeback?: GlobalActionWritebackHandler<Record<string, unknown>, TWriteback>
  readonly edits?: GlobalActionEditsHandler<Record<string, unknown>, TWriteback>
  readonly effects?: GlobalActionEffectsHandler<Record<string, unknown>, TWriteback>
}

export interface ObjectActionPhaseDefinitions<TWriteback = unknown> {
  readonly validate: readonly ActionValidator<
    ObjectTypeWithPropertyTokens,
    Record<string, unknown>
  >[]
  readonly writeback?: ActionWritebackHandler<
    ObjectTypeWithPropertyTokens,
    Record<string, unknown>,
    TWriteback
  >
  readonly edits?: ActionEditsHandler<
    ObjectTypeWithPropertyTokens,
    Record<string, unknown>,
    TWriteback
  >
  readonly effects?: ActionEffectsHandler<
    ObjectTypeWithPropertyTokens,
    Record<string, unknown>,
    TWriteback
  >
}

export interface GlobalActionDefinition<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
  _TWriteback = unknown,
> extends BaseActionDefinition<TId, TParams> {
  readonly binding: { readonly kind: "global" }
  readonly phases: GlobalActionPhaseDefinitions
}

export interface ObjectActionDefinition<
  TId extends string = string,
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
  TParams extends ActionParamsConfig = ActionParamsConfig,
  _TWriteback = unknown,
> extends BaseActionDefinition<TId, TParams> {
  readonly binding: { readonly kind: "object"; readonly objectType: TObjectType }
  readonly phases: ObjectActionPhaseDefinitions
}

export type ActionDefinition<
  TId extends string = string,
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
  TParams extends ActionParamsConfig = ActionParamsConfig,
  TWriteback = unknown,
> =
  | GlobalActionDefinition<TId, TParams, TWriteback>
  | ObjectActionDefinition<TId, TObjectType, TParams, TWriteback>

export interface GlobalActionAfterWritebackBuilder<
  TId extends string,
  TParams extends ActionParamsConfig,
  TWriteback,
> extends GlobalActionDefinition<TId, TParams, TWriteback> {
  edits<const TResult extends ActionNoResultHandlerResult>(
    handler: GlobalActionEditsHandler<
      InferActionParams<TParams>,
      ActionWritebackValue<TWriteback>,
      TResult
    >
  ): GlobalActionAfterEditsBuilder<TId, TParams, ActionWritebackValue<TWriteback>>
}

export interface ObjectActionAfterWritebackBuilder<
  TId extends string,
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends ActionParamsConfig,
  TWriteback,
> extends ObjectActionDefinition<TId, TObjectType, TParams, TWriteback> {
  edits<const TResult extends ActionNoResultHandlerResult>(
    handler: ActionEditsHandler<
      TObjectType,
      InferActionParams<TParams>,
      ActionWritebackValue<TWriteback>,
      TResult
    >
  ): ObjectActionAfterEditsBuilder<TId, TObjectType, TParams, ActionWritebackValue<TWriteback>>
}

export interface GlobalActionAfterEditsBuilder<
  TId extends string,
  TParams extends ActionParamsConfig,
  TWriteback,
> extends GlobalActionDefinition<TId, TParams, TWriteback> {
  effects<const TResult extends ActionNoResultHandlerResult>(
    handler: GlobalActionEffectsHandler<InferActionParams<TParams>, TWriteback, TResult>
  ): GlobalActionDefinition<TId, TParams, TWriteback>
}

export interface ObjectActionAfterEditsBuilder<
  TId extends string,
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends ActionParamsConfig,
  TWriteback,
> extends ObjectActionDefinition<TId, TObjectType, TParams, TWriteback> {
  effects<const TResult extends ActionNoResultHandlerResult>(
    handler: ActionEffectsHandler<TObjectType, InferActionParams<TParams>, TWriteback, TResult>
  ): ObjectActionDefinition<TId, TObjectType, TParams, TWriteback>
}

export interface GlobalActionPhaseBuilder<TId extends string, TParams extends ActionParamsConfig> {
  validate(
    validator: GlobalActionValidator<InferActionParams<TParams>>
  ): GlobalActionPhaseBuilder<TId, TParams>
  writeback<const TResult>(
    handler: GlobalActionWritebackHandler<InferActionParams<TParams>, TResult> &
      GlobalActionWritebackHandler<
        InferActionParams<TParams>,
        WritebackResult<NoInfer<Awaited<TResult>>>
      >
  ): GlobalActionAfterWritebackBuilder<TId, TParams, TResult>
  edits<const TResult extends ActionNoResultHandlerResult>(
    handler: GlobalActionEditsHandler<InferActionParams<TParams>, undefined, TResult>
  ): GlobalActionAfterEditsBuilder<TId, TParams, undefined>
}

export interface ObjectActionPhaseBuilder<
  TId extends string,
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends ActionParamsConfig,
> {
  validate(
    validator: ActionValidator<TObjectType, InferActionParams<TParams>>
  ): ObjectActionPhaseBuilder<TId, TObjectType, TParams>
  writeback<const TResult>(
    handler: ActionWritebackHandler<TObjectType, InferActionParams<TParams>, TResult> &
      ActionWritebackHandler<
        TObjectType,
        InferActionParams<TParams>,
        WritebackResult<NoInfer<Awaited<TResult>>>
      >
  ): ObjectActionAfterWritebackBuilder<TId, TObjectType, TParams, TResult>
  edits<const TResult extends ActionNoResultHandlerResult>(
    handler: ActionEditsHandler<TObjectType, InferActionParams<TParams>, undefined, TResult>
  ): ObjectActionAfterEditsBuilder<TId, TObjectType, TParams, undefined>
}

export interface GlobalActionParamsBuilder<TId extends string> {
  params<const TParams extends ActionParamsConfig>(
    params: TParams
  ): GlobalActionPhaseBuilder<TId, TParams>
}

export interface ObjectActionParamsBuilder<
  TId extends string,
  TObjectType extends ObjectTypeWithPropertyTokens,
> {
  params<const TParams extends ActionParamsConfig>(
    params: TParams
  ): ObjectActionPhaseBuilder<TId, TObjectType, TParams>
}

export interface ActionBuilder<TId extends string> extends GlobalActionParamsBuilder<TId> {
  on<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ObjectActionParamsBuilder<TId, TObjectType>
}
