import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type {
  ActionEditsContext,
  ActionEffectsContext,
  ActionValidationContext,
  ActionWritebackContext,
  GlobalActionEditsContext,
  GlobalActionEffectsContext,
  GlobalActionValidationContext,
  GlobalActionWritebackContext,
} from "./context"

type MaybePromise<T> = T | Promise<T>
type VoidResult = ReturnType<() => void>
export type ActionNoResultHandlerResult = VoidResult | Promise<VoidResult>

export type ActionValidationFailure = { readonly error: string }

export type GlobalActionValidator<TParams extends Record<string, unknown>> = (
  ctx: GlobalActionValidationContext<TParams>
) => void | ActionValidationFailure | Promise<void> | Promise<ActionValidationFailure | undefined>

export type ActionValidator<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
> = (
  ctx: ActionValidationContext<TObjectType, TParams>
) => void | ActionValidationFailure | Promise<void> | Promise<ActionValidationFailure | undefined>

export type GlobalActionWritebackHandler<TParams extends Record<string, unknown>, TResult> = (
  ctx: GlobalActionWritebackContext<TParams>
) => MaybePromise<TResult>

export type ActionWritebackHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TResult,
> = (ctx: ActionWritebackContext<TObjectType, TParams>) => MaybePromise<TResult>

export type GlobalActionEditsHandler<
  TParams extends Record<string, unknown>,
  TWriteback,
  TResult extends ActionNoResultHandlerResult = ActionNoResultHandlerResult,
> = (ctx: GlobalActionEditsContext<TParams, TWriteback>) => TResult

export type ActionEditsHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
  TResult extends ActionNoResultHandlerResult = ActionNoResultHandlerResult,
> = (ctx: ActionEditsContext<TObjectType, TParams, TWriteback>) => TResult

export type GlobalActionEffectsHandler<
  TParams extends Record<string, unknown>,
  TWriteback,
  TResult extends ActionNoResultHandlerResult = ActionNoResultHandlerResult,
> = (ctx: GlobalActionEffectsContext<TParams, TWriteback>) => TResult

export type ActionEffectsHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
  TResult extends ActionNoResultHandlerResult = ActionNoResultHandlerResult,
> = (ctx: ActionEffectsContext<TObjectType, TParams, TWriteback>) => TResult

export type ActionWritebackValue<TResult> = [Awaited<TResult>] extends [VoidResult]
  ? null
  : Awaited<TResult>
