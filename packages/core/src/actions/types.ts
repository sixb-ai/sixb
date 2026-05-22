import type { InferSchemaOrRef, ObjectType, SchemaOrRef, ValueType } from "../ontology"
import type { InferObjectProperties } from "../ontology/inference"
import type { QuantitativeTypeId } from "../ontology/units"
import type { Pario } from "../runtime/pario"
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
type InferActionParamValue<
  TSchema extends SchemaOrRef,
  TValueTypes extends readonly ValueType[],
> = TSchema extends "date" | "timestamp" ? Date : InferSchemaOrRef<TSchema, TValueTypes>

export type InferActionParams<
  TParams extends ActionParamsConfig,
  TValueTypes extends readonly ValueType[] = [],
> = Simplify<
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

export interface ActionContext<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> {
  readonly params: TParams
  readonly target: ActionTargetObject<TObjectType>
  readonly pario: Pario<readonly OntologySource[]>
  readonly signal: AbortSignal
}

export interface ActionValidationContext<
  TObjectType extends ObjectType,
  TParams extends Record<string, unknown>,
> {
  readonly params: TParams
  readonly target: ActionTargetObject<TObjectType>
  readonly signal: AbortSignal
}

// biome-ignore lint/suspicious/noConfusingVoidType: Validators intentionally allow implicit void returns.
type ActionValidatorResult = void | { error: string } | Promise<void | { error: string }>

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

export interface ActionDefinition<
  TId extends string = string,
  TObjectType extends ObjectType = ObjectType,
  TParams extends ActionParamsConfig = ActionParamsConfig,
> {
  readonly kind: "action"
  readonly id: TId
  readonly target: TObjectType
  readonly params: TParams
  readonly validators: readonly ActionValidator<ObjectType, Record<string, unknown>>[]
  readonly handler: ActionHandler<ObjectType, Record<string, unknown>>
  readonly description?: string
}

export interface ActionRunBuilder<
  TId extends string,
  TObjectType extends ObjectType,
  TParams extends ActionParamsConfig,
> {
  validate(
    validator: ActionValidator<TObjectType, InferActionParams<TParams>>
  ): ActionRunBuilder<TId, TObjectType, TParams>
  run(
    handler: ActionHandler<TObjectType, InferActionParams<TParams>>
  ): ActionDefinition<TId, TObjectType, TParams>
}

export interface ActionParamsBuilder<TId extends string, TObjectType extends ObjectType> {
  params<const TParams extends ActionParamsConfig>(
    params: TParams
  ): ActionRunBuilder<TId, TObjectType, TParams>
}

export interface ActionTargetBuilder<TId extends string> {
  target<const TObjectType extends ObjectType>(
    objectType: TObjectType
  ): ActionParamsBuilder<TId, TObjectType>
}
