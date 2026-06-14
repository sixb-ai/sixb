import type { JsonValue } from "../json"
import type { ObjectRef, ObjectType, Property, ValueType } from "../ontology"
import type { InferPropertyValue } from "../ontology/inference"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../ontology/tokens"

export type EditBatchVersion = 1

declare const editObjectHandleBrand: unique symbol

export interface EditObjectRef<TObjectTypeId extends string = string>
  extends ObjectRef<TObjectTypeId> {}

export interface TypedEditObjectRef<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
> extends EditObjectRef<TObjectType["id"]> {
  readonly [editObjectHandleBrand]: TObjectType
  readonly objectType: TObjectType
}

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
  TMode extends "create" | "set",
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

export type EditSetProperties<
  TObjectType extends ObjectType,
  TValueTypes extends readonly ValueType[] = [],
> = StaticPropertyMap<TObjectType["properties"], TValueTypes, "set">

type LinkProperties<TLink extends { properties?: readonly Property[] }> =
  TLink["properties"] extends readonly Property[] ? TLink["properties"] : []

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

type HasKnownLinkProperties<TLink extends { properties?: readonly Property[] }> =
  keyof EditLinkProperties<TLink, []> extends never ? false : true

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

type EditPropertyTokenValue<
  TPropertyToken extends PropertyToken<string, string, Property>,
  TValueTypes extends readonly ValueType[],
> = string extends TPropertyToken["id"]
  ? unknown
  : InferPropertyValue<TPropertyToken["property"], TValueTypes>

type EditLinkSourceRef<TLinkToken extends LinkToken<string, string, string | readonly string[]>> =
  string extends TLinkToken["id"]
    ? EditObjectRef<string>
    : EditObjectRef<TLinkToken["objectTypeId"] & string>

type EditLinkTargetRef<TLinkToken extends LinkToken<string, string, string | readonly string[]>> =
  string extends TLinkToken["id"]
    ? EditObjectRef<string>
    : EditObjectRef<ResolveTargetObjectTypeId<TLinkToken["targetObjectTypeId"]>>

type EditLinkOptionsArg<
  TLinkToken extends LinkToken<string, string, string | readonly string[]>,
  TValueTypes extends readonly ValueType[],
> = string extends TLinkToken["id"]
  ? [options?: { readonly properties?: Readonly<Record<string, unknown>> }]
  : HasKnownLinkProperties<TLinkToken["link"]> extends false
    ? [options?: { readonly properties?: never }]
    : HasRequiredLinkProperties<TLinkToken["link"]> extends true
      ? [
          options: {
            readonly properties: NoInfer<EditLinkProperties<TLinkToken["link"], TValueTypes>>
          },
        ]
      : [
          options?: {
            readonly properties?: NoInfer<EditLinkProperties<TLinkToken["link"], TValueTypes>>
          },
        ]

type RawEditRefProperties<TRef extends EditObjectRef> = TRef extends {
  readonly objectType: ObjectTypeWithPropertyTokens
}
  ? never
  : Readonly<Record<string, JsonValue>>

export interface CreateEditBuilderOptions {
  readonly runId: string
  readonly valueTypesById?: ReadonlyMap<string, ValueType>
}

export interface EditChain<TValueTypes extends readonly ValueType[] = []> {
  set<const TObjectType extends ObjectTypeWithPropertyTokens>(
    object: TypedEditObjectRef<TObjectType>,
    properties: NoInfer<EditSetProperties<TObjectType, TValueTypes>>
  ): EditChain<TValueTypes>
  set<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType,
    primaryId: string,
    properties: NoInfer<EditSetProperties<TObjectType, TValueTypes>>
  ): EditChain<TValueTypes>
  set<
    const TObjectTypeId extends string,
    const TPropertyToken extends PropertyToken<TObjectTypeId, string, Property>,
  >(
    ref: EditObjectRef<TObjectTypeId>,
    property: TPropertyToken,
    value: NoInfer<EditPropertyTokenValue<TPropertyToken, TValueTypes>>
  ): EditChain<TValueTypes>
  set<const TRef extends EditObjectRef>(
    ref: TRef,
    properties: RawEditRefProperties<TRef>
  ): EditChain<TValueTypes>

  delete<const TObjectType extends ObjectType>(
    objectType: TObjectType,
    primaryId: string
  ): EditChain<TValueTypes>
  delete<const TObjectTypeId extends string>(
    ref: EditObjectRef<TObjectTypeId>
  ): EditChain<TValueTypes>

  link<const TLinkToken extends LinkToken<string, string, string | readonly string[]>>(
    source: EditLinkSourceRef<TLinkToken>,
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>,
    ...options: EditLinkOptionsArg<TLinkToken, TValueTypes>
  ): EditChain<TValueTypes>

  unlink<const TLinkToken extends LinkToken<string, string, string | readonly string[]>>(
    source: EditLinkSourceRef<TLinkToken>,
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>
  ): EditChain<TValueTypes>

  toEditBatch(): EditBatch
}

export interface EditBuilder<TValueTypes extends readonly ValueType[] = []>
  extends Omit<EditChain<TValueTypes>, "set" | "delete" | "link" | "unlink"> {
  object<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType,
    primaryId: string
  ): EditObjectHandle<TObjectType, TValueTypes>

  ref<const TObjectType extends ObjectType>(
    objectType: TObjectType,
    primaryId: string
  ): EditObjectRef<TObjectType["id"]>

  create<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType,
    properties: NoInfer<EditCreateProperties<TObjectType, TValueTypes>>
  ): EditObjectCreateHandle<TObjectType, TValueTypes>

  set<const TObjectType extends ObjectTypeWithPropertyTokens>(
    object: TypedEditObjectRef<TObjectType>,
    properties: NoInfer<EditSetProperties<TObjectType, TValueTypes>>
  ): EditOperationHandle<EditObjectUpdateOperation, TValueTypes>
  set<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType,
    primaryId: string,
    properties: NoInfer<EditSetProperties<TObjectType, TValueTypes>>
  ): EditOperationHandle<EditObjectUpdateOperation, TValueTypes>
  set<
    const TObjectTypeId extends string,
    const TPropertyToken extends PropertyToken<TObjectTypeId, string, Property>,
  >(
    ref: EditObjectRef<TObjectTypeId>,
    property: TPropertyToken,
    value: NoInfer<EditPropertyTokenValue<TPropertyToken, TValueTypes>>
  ): EditOperationHandle<EditObjectUpdateOperation, TValueTypes>
  set<const TRef extends EditObjectRef>(
    ref: TRef,
    properties: RawEditRefProperties<TRef>
  ): EditOperationHandle<EditObjectUpdateOperation, TValueTypes>

  delete<const TObjectType extends ObjectType>(
    objectType: TObjectType,
    primaryId: string
  ): EditOperationHandle<EditObjectDeleteOperation, TValueTypes>
  delete<const TObjectTypeId extends string>(
    ref: EditObjectRef<TObjectTypeId>
  ): EditOperationHandle<EditObjectDeleteOperation, TValueTypes>

  link<const TLinkToken extends LinkToken<string, string, string | readonly string[]>>(
    source: EditLinkSourceRef<TLinkToken>,
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>,
    ...options: EditLinkOptionsArg<TLinkToken, TValueTypes>
  ): EditOperationHandle<EditLinkCreateOperation, TValueTypes>

  unlink<const TLinkToken extends LinkToken<string, string, string | readonly string[]>>(
    source: EditLinkSourceRef<TLinkToken>,
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>
  ): EditOperationHandle<EditLinkDeleteOperation, TValueTypes>
}

export interface EditOperationHandle<
  TOperation extends EditOperation = EditOperation,
  TValueTypes extends readonly ValueType[] = [],
> extends EditChain<TValueTypes>,
    EditOperationHandleInput<TOperation> {}

export interface EditOperationHandleInput<TOperation extends EditOperation = EditOperation> {
  readonly operation: TOperation
  toEditOperation(): TOperation
  toEditBatch(): EditBatch
}

export interface EditBatchProducer {
  toEditBatch(): EditBatch
}

export interface EditObjectHandle<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[] = [],
> extends TypedEditObjectRef<TObjectType> {
  set(
    properties: NoInfer<EditSetProperties<TObjectType, TValueTypes>>
  ): EditOperationHandle<EditObjectUpdateOperation, TValueTypes>

  delete(): EditOperationHandle<EditObjectDeleteOperation, TValueTypes>

  link<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>,
    ...options: EditLinkOptionsArg<TLinkToken, TValueTypes>
  ): EditOperationHandle<EditLinkCreateOperation, TValueTypes>

  unlink<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>
  ): EditOperationHandle<EditLinkDeleteOperation, TValueTypes>

  toEditBatch(): EditBatch
}

export interface EditObjectCreateHandle<
  TObjectType extends ObjectTypeWithPropertyTokens = ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[] = [],
> extends EditObjectHandle<TObjectType, TValueTypes>,
    EditOperationHandleInput<EditObjectCreateOperation> {}

export type EditBatchInput =
  | EditBatch
  | EditOperation
  | EditBatchProducer
  | EditOperationHandleInput
  | readonly (EditOperation | EditOperationHandleInput)[]

export interface NormalizedEditBatchResult {
  readonly batch: EditBatch
}
