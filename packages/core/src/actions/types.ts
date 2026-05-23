import type {
  InferSchemaOrRef,
  ObjectRef,
  ObjectRefSchema,
  ObjectType,
  SchemaOrRef,
  ValueType,
} from "../ontology"
import type { InferObjectProperties } from "../ontology/inference"
import type { QuantitativeTypeId } from "../ontology/units"
import type { Sixb } from "../runtime/sixb"
import type { OntologySource } from "../runtime/types"

type Simplify<T> = { [K in keyof T]: T[K] } & {}

export interface ActionParamConfig {
  readonly schema: SchemaOrRef
  readonly required?: boolean
  readonly description?: string
  readonly semanticType?: QuantitativeTypeId
}

export type ActionParamsConfig = Record<string, ActionParamConfig>

type RequiredParamKeys<TParams extends ActionParamsConfig> = {
  [K in keyof TParams]-?: TParams[K]["required"] extends true ? K : never
}[keyof TParams]

type OptionalParamKeys<TParams extends ActionParamsConfig> = Exclude<
  keyof TParams,
  RequiredParamKeys<TParams>
>

/**
 * Action params normalize "date" / "timestamp" schemas to `Date` (the wider
 * `InferSchema` form returns `Date | string` to keep storage layers permissive).
 * Handlers see the validated value, so narrowing to `Date` is sound here.
 */
type ActionPrimitiveSchemaValues = {
  string: string
  uuid: string
  boolean: boolean
  integer: number
  double: number
  decimal: number
  date: Date
  timestamp: Date
}

type InferActionStructuredParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[],
> = TSchema extends { type: "enum"; values: readonly (infer TValue)[] }
  ? TValue
  : TSchema extends ObjectRefSchema<infer TObjectTypeId>
    ? ObjectRef<TObjectTypeId>
    : InferSchemaOrRef<TSchema, TValueTypes>

type InferActionParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[] = [],
> = TSchema extends keyof ActionPrimitiveSchemaValues
  ? ActionPrimitiveSchemaValues[TSchema]
  : InferActionStructuredParamValue<TSchema, TValueTypes>

export type InferActionParams<
  TParams extends ActionParamsConfig,
  TValueTypes extends readonly ValueType[] = [],
> = string extends keyof TParams
  ? Record<string, unknown>
  : Simplify<
      {
        [K in RequiredParamKeys<TParams>]: InferActionParamValue<TParams[K]["schema"], TValueTypes>
      } & {
        [K in OptionalParamKeys<TParams>]?: InferActionParamValue<TParams[K]["schema"], TValueTypes>
      }
    >

type InferActionTargetProperties<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[],
> = string extends TObjectType["id"]
  ? Record<string, unknown>
  : InferObjectProperties<TObjectType, TValueTypes>

export interface ActionTargetObject<
  TObjectType extends ObjectType = ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> {
  readonly primaryId: string
  readonly objectTypeId: string
  readonly properties: InferActionTargetProperties<TObjectType, TValueTypes>
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ActionSubject =
  | { readonly kind: "none" }
  | { readonly kind: "object"; readonly objectTypeId: string; readonly primaryId: string }

export type ActionBinding<TObjectType extends ObjectType = ObjectType> =
  | { readonly kind: "global" }
  | { readonly kind: "object"; readonly objectType: TObjectType }

export interface GlobalActionContext<TParams extends Record<string, unknown>> {
  readonly params: TParams
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly signal: AbortSignal
}

export interface ActionContext<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> extends GlobalActionContext<TParams> {
  readonly target: ActionTargetObject<TObjectType>
}

export interface GlobalActionValidationContext<TParams extends Record<string, unknown>> {
  readonly params: TParams
  readonly signal: AbortSignal
}

export interface ActionValidationContext<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> extends GlobalActionValidationContext<TParams> {
  readonly target: ActionTargetObject<TObjectType>
}

// biome-ignore lint/suspicious/noConfusingVoidType: Validators intentionally allow implicit void returns.
type ActionValidatorResult = void | { error: string } | Promise<void | { error: string }>

export type GlobalActionValidator<TParams extends Record<string, unknown>> = {
  bivarianceHack(ctx: GlobalActionValidationContext<TParams>): ActionValidatorResult
}["bivarianceHack"]

export type ActionValidator<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> = {
  bivarianceHack(ctx: ActionValidationContext<TObjectType, TParams>): ActionValidatorResult
}["bivarianceHack"]

export type ActionHandler<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> = {
  bivarianceHack(ctx: ActionContext<TObjectType, TParams>): void | Promise<void>
}["bivarianceHack"]

export type GlobalActionHandler<TParams extends Record<string, unknown>> = {
  bivarianceHack(ctx: GlobalActionContext<TParams>): void | Promise<void>
}["bivarianceHack"]

export interface BaseActionDefinition<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> {
  readonly kind: "action"
  readonly id: TId
  readonly params: TParams
  readonly description?: string
}

export interface GlobalActionDefinition<
  TId extends string = string,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> extends BaseActionDefinition<TId, TParams> {
  readonly binding: { readonly kind: "global" }
  readonly target?: undefined
  readonly validators: readonly GlobalActionValidator<Record<string, unknown>>[]
  readonly handler: GlobalActionHandler<Record<string, unknown>>
}

export interface ObjectActionDefinition<
  TId extends string = string,
  TObjectType extends ObjectType = ObjectType,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> extends BaseActionDefinition<TId, TParams> {
  readonly binding: { readonly kind: "object"; readonly objectType: TObjectType }
  /** Compatibility alias for the object-scoped action binding. Prefer `binding.objectType`. */
  readonly target: TObjectType
  readonly validators: readonly ActionValidator<ObjectType, Record<string, unknown>>[]
  readonly handler: ActionHandler<ObjectType, Record<string, unknown>>
}

export type ActionDefinition<
  TId extends string = string,
  TObjectType extends ObjectType = ObjectType,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> = GlobalActionDefinition<TId, TParams> | ObjectActionDefinition<TId, TObjectType, TParams>

export interface GlobalActionRunBuilder<TId extends string, TParams extends ActionParamsConfig> {
  validate(
    validator: GlobalActionValidator<InferActionParams<TParams>>
  ): GlobalActionRunBuilder<TId, TParams>
  run(
    handler: GlobalActionHandler<InferActionParams<TParams>>
  ): GlobalActionDefinition<TId, TParams>
}

export interface ObjectActionRunBuilder<
  TId extends string,
  TObjectType extends ObjectType,
  TParams extends ActionParamsConfig,
> {
  validate(
    validator: ActionValidator<TObjectType, InferActionParams<TParams>>
  ): ObjectActionRunBuilder<TId, TObjectType, TParams>
  run(
    handler: ActionHandler<TObjectType, InferActionParams<TParams>>
  ): ObjectActionDefinition<TId, TObjectType, TParams>
}

export interface GlobalActionParamsBuilder<TId extends string> {
  params<const TParams extends ActionParamsConfig>(
    params: TParams
  ): GlobalActionRunBuilder<TId, TParams>
}

export interface ObjectActionParamsBuilder<TId extends string, TObjectType extends ObjectType> {
  params<const TParams extends ActionParamsConfig>(
    params: TParams
  ): ObjectActionRunBuilder<TId, TObjectType, TParams>
}

export interface ActionBuilder<TId extends string> extends GlobalActionParamsBuilder<TId> {
  on<const TObjectType extends ObjectType>(
    objectType: TObjectType
  ): ObjectActionParamsBuilder<TId, TObjectType>
  target<const TObjectType extends ObjectType>(
    objectType: TObjectType
  ): ObjectActionParamsBuilder<TId, TObjectType>
}

/** Compatibility alias. Prefer `ObjectActionRunBuilder`. */
export type ActionRunBuilder<
  TId extends string,
  TObjectType extends ObjectType,
  TParams extends ActionParamsConfig,
> = ObjectActionRunBuilder<TId, TObjectType, TParams>

/** Compatibility alias. Prefer `ObjectActionParamsBuilder`. */
export type ActionParamsBuilder<
  TId extends string,
  TObjectType extends ObjectType,
> = ObjectActionParamsBuilder<TId, TObjectType>

/** Compatibility alias. Prefer `ActionBuilder`. */
export type ActionTargetBuilder<TId extends string> = ActionBuilder<TId>
