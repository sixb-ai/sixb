import type { EditBatchInput } from "../../edits"
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

export type ActionValidationFailure = { readonly error: string }

type ActionValidatorResult =
  | void
  | ActionValidationFailure
  // biome-ignore lint/suspicious/noConfusingVoidType: Async validators intentionally allow implicit no-error returns.
  | Promise<void | ActionValidationFailure>

// biome-ignore lint/suspicious/noConfusingVoidType: Edits handlers intentionally allow implicit no-edit returns.
type ActionEditsHandlerResult = MaybePromise<EditBatchInput | void>

export type GlobalActionValidator<TParams extends Record<string, unknown>> = (
  ctx: GlobalActionValidationContext<TParams>
) => ActionValidatorResult

export type ActionValidator<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
> = (ctx: ActionValidationContext<TObjectType, TParams>) => ActionValidatorResult

export type GlobalActionWritebackHandler<TParams extends Record<string, unknown>, TResult> = (
  ctx: GlobalActionWritebackContext<TParams>
) => MaybePromise<TResult>

export type ActionWritebackHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TResult,
> = (ctx: ActionWritebackContext<TObjectType, TParams>) => MaybePromise<TResult>

export type GlobalActionEditsHandler<TParams extends Record<string, unknown>, TWriteback> = (
  ctx: GlobalActionEditsContext<TParams, TWriteback>
) => ActionEditsHandlerResult

export type ActionEditsHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
> = (ctx: ActionEditsContext<TObjectType, TParams, TWriteback>) => ActionEditsHandlerResult

export type GlobalActionEffectsHandler<TParams extends Record<string, unknown>, TWriteback> = (
  ctx: GlobalActionEffectsContext<TParams, TWriteback>
) => void | Promise<void>

export type ActionEffectsHandler<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
> = (ctx: ActionEffectsContext<TObjectType, TParams, TWriteback>) => void | Promise<void>

// biome-ignore lint/suspicious/noConfusingVoidType: Void writebacks normalize to a stored null result.
export type ActionWritebackValue<TResult> = [Awaited<TResult>] extends [void]
  ? null
  : Awaited<TResult>
