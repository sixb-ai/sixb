import type { JsonValue } from "../json"
import type { ObjectRef, ObjectType, Property, ValueType } from "../ontology"
import type { InferPropertyValue } from "../ontology/inference"
import type { LinkToken, ObjectTypeWithPropertyTokens } from "../ontology/tokens"

export type EditBatchVersion = 1

export interface EditObjectRef<TObjectTypeId extends string = string>
  extends ObjectRef<TObjectTypeId> {}

export interface TypedEditObjectRef<TObjectType extends ObjectType = ObjectType>
  extends EditObjectRef<TObjectType["id"]> {}

export type EditObjectProperties = Readonly<Record<string, JsonValue>>

export interface EditObjectCreateOperation {
  readonly kind: "object.create"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: EditObjectProperties
}

export interface EditObjectUpdateOperation {
  readonly kind: "object.update"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: EditObjectProperties
}

export interface EditObjectDeleteOperation {
  readonly kind: "object.delete"
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface EditLinkCreateOperation {
  readonly kind: "link.create"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
  readonly properties?: EditObjectProperties
}

export interface EditLinkDeleteOperation {
  readonly kind: "link.delete"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
}

export type EditOperation =
  | EditObjectCreateOperation
  | EditObjectUpdateOperation
  | EditObjectDeleteOperation
  | EditLinkCreateOperation
  | EditLinkDeleteOperation

export interface EditBatch {
  readonly version: EditBatchVersion
  readonly operations: readonly EditOperation[]
}

export interface EditObjectDiff {
  readonly objectTypeId: string
  readonly primaryId: string
  readonly operation: "create" | "update" | "delete"
  readonly changedProperties: readonly string[]
}

export interface EditLinkDiff {
  readonly operation: "create" | "update" | "delete"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
}

export interface EditCommitDiff {
  readonly objects: readonly EditObjectDiff[]
  readonly links: readonly EditLinkDiff[]
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type NonTelemetryProperty<TProperty extends Property> = TProperty extends { mode: "telemetry" }
  ? never
  : TProperty

type SettableProperty<TProperty extends Property> = TProperty extends { primary: true }
  ? never
  : NonTelemetryProperty<TProperty>

type EditablePropertyId<TProperty extends Property> =
  SettableProperty<TProperty> extends never ? never : TProperty["id"]

type CreatablePropertyId<TProperty extends Property> =
  NonTelemetryProperty<TProperty> extends never ? never : TProperty["id"]

type StaticPropertyMap<
  TProperties extends readonly Property[],
  TValueTypes extends readonly ValueType[],
  TMode extends "create" | "update",
> = string extends TProperties[number]["id"]
  ? Record<string, unknown>
  : Simplify<{
      [TProp in TProperties[number] as TMode extends "create"
        ? CreatablePropertyId<TProp>
        : EditablePropertyId<TProp>]?: InferPropertyValue<TProp, TValueTypes>
    }>

export type EditCreateProperties<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> = StaticPropertyMap<TObjectType["properties"], TValueTypes, "create">

export type EditUpdateProperties<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> = StaticPropertyMap<TObjectType["properties"], TValueTypes, "update">

type LinkProperties<TLink extends { properties?: readonly Property[] }> = TLink extends {
  properties: infer TProperties extends readonly Property[]
}
  ? TProperties
  : []

type LinkPropertyId<TProperty extends Property> =
  NonTelemetryProperty<TProperty> extends never ? never : TProperty["id"]

type RequiredLinkPropertyId<TProperty extends Property> = TProperty extends { required: true }
  ? LinkPropertyId<TProperty>
  : never

type EditLinkProperties<
  TLink extends { properties?: readonly Property[] },
  TValueTypes extends readonly ValueType[],
> = string extends LinkProperties<TLink>[number]["id"]
  ? Record<string, unknown>
  : Simplify<
      {
        [TProp in LinkProperties<TLink>[number] as RequiredLinkPropertyId<TProp>]: InferPropertyValue<
          TProp,
          TValueTypes
        >
      } & {
        [TProp in LinkProperties<TLink>[number] as TProp extends { required: true }
          ? never
          : LinkPropertyId<TProp>]?: InferPropertyValue<TProp, TValueTypes>
      }
    >

type RequiredLinkPropertyIds<TLink extends { properties?: readonly Property[] }> =
  LinkProperties<TLink>[number] extends infer TProperty extends Property
    ? RequiredLinkPropertyId<TProperty>
    : never

type HasLinkProperties<TLink extends { properties?: readonly Property[] }> =
  LinkProperties<TLink> extends [] ? false : true

type HasRequiredLinkProperties<TLink extends { properties?: readonly Property[] }> = [
  RequiredLinkPropertyIds<TLink>,
] extends [never]
  ? false
  : true

type ResolveTargetObjectTypeId<TTargetObjectTypeId> =
  TTargetObjectTypeId extends readonly (infer TTargetId extends string)[]
    ? TTargetId
    : TTargetObjectTypeId extends string
      ? TTargetObjectTypeId
      : never

type EditLinkTargetRef<TLinkToken extends LinkToken<string, string, string | readonly string[]>> =
  string extends TLinkToken["id"]
    ? EditObjectRef<string>
    : EditObjectRef<ResolveTargetObjectTypeId<TLinkToken["targetObjectTypeId"]>>

type EditLinkOptionsArg<
  TLinkToken extends LinkToken<string, string, string | readonly string[]>,
  TValueTypes extends readonly ValueType[],
> = string extends TLinkToken["id"]
  ? [options?: { readonly properties?: Readonly<Record<string, unknown>> }]
  : HasLinkProperties<TLinkToken["link"]> extends false
    ? [options?: { readonly properties?: never }]
    : HasRequiredLinkProperties<TLinkToken["link"]> extends true
      ? [
          options: {
            readonly properties: EditLinkProperties<TLinkToken["link"], TValueTypes>
          },
        ]
      : [
          options?: {
            readonly properties?: EditLinkProperties<TLinkToken["link"], TValueTypes>
          },
        ]

export interface RecordEditsOptions {
  readonly runId: string
  readonly valueTypesById?: ReadonlyMap<string, ValueType>
}

export interface RecordEditsContext<TValueTypes extends readonly ValueType[] = []> {
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): EditObjectSetRecorder<TObjectType, TValueTypes>
}

export type RecordEditsHandlerResult = ReturnType<() => void>

export type RecordEditsHandlerReturn = RecordEditsHandlerResult | Promise<RecordEditsHandlerResult>

export type RecordEditsHandler<
  TValueTypes extends readonly ValueType[] = [],
  TResult extends RecordEditsHandlerReturn = RecordEditsHandlerReturn,
> = (ctx: RecordEditsContext<TValueTypes>) => TResult

export interface EditObjectSetRecorder<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> {
  byId(primaryId: string): EditObjectHandle<TObjectType, TValueTypes>

  create(
    properties: EditCreateProperties<TObjectType, TValueTypes>
  ): EditObjectHandle<TObjectType, TValueTypes>
}

export interface EditObjectHandle<
  TObjectType extends ObjectType = ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> extends TypedEditObjectRef<TObjectType> {
  update(properties: EditUpdateProperties<TObjectType, TValueTypes>): void

  delete(): void

  link<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>,
    ...options: EditLinkOptionsArg<TLinkToken, TValueTypes>
  ): void

  unlink<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>
  ): void
}

export interface EditBatchProducer {
  toEditBatch(): EditBatch
}

export type EditBatchInput =
  | EditBatch
  | EditOperation
  | EditBatchProducer
  | readonly EditOperation[]

export interface NormalizedEditBatchResult {
  readonly batch: EditBatch
}
