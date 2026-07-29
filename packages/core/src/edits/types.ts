import type { JsonValue } from "../json"
import type { ObjectRef, ObjectType, Property, ValueType } from "../ontology"
import type { InferPropertyValue } from "../ontology/inference"
import type { LinkToken, ObjectTypeWithPropertyTokens } from "../ontology/tokens"

export interface EditObjectRef<TObjectTypeId extends string = string>
  extends ObjectRef<TObjectTypeId> {}

export interface TypedEditObjectRef<TObjectType extends ObjectType = ObjectType>
  extends EditObjectRef<TObjectType["id"]> {}

/** Authored property values, already normalized to JSON by the recorder. */
export type EditObjectProperties = Readonly<Record<string, JsonValue>>

export interface ObjectCreateEdit {
  readonly kind: "object.create"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: EditObjectProperties
}

export interface ObjectUpdateEdit {
  readonly kind: "object.update"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly properties: EditObjectProperties
}

export interface ObjectUnsetEdit {
  readonly kind: "object.unset"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly propertyIds: readonly string[]
}

export interface ObjectResetEdit {
  readonly kind: "object.reset"
  readonly objectTypeId: string
  readonly primaryId: string
  readonly propertyIds: readonly string[]
}

export interface ObjectDeleteEdit {
  readonly kind: "object.delete"
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface ObjectRestoreEdit {
  readonly kind: "object.restore"
  readonly objectTypeId: string
  readonly primaryId: string
}

export interface LinkUpsertEdit {
  readonly kind: "link.upsert"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
  readonly properties?: EditObjectProperties
}

export interface LinkDeleteEdit {
  readonly kind: "link.delete"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
}

export interface LinkResetEdit {
  readonly kind: "link.reset"
  readonly source: EditObjectRef
  readonly linkId: string
  readonly target: EditObjectRef
}

export type EditOperation =
  | ObjectCreateEdit
  | ObjectUpdateEdit
  | ObjectUnsetEdit
  | ObjectResetEdit
  | ObjectDeleteEdit
  | ObjectRestoreEdit
  | LinkUpsertEdit
  | LinkDeleteEdit
  | LinkResetEdit

export interface EditBatch {
  readonly operations: readonly EditOperation[]
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type NonTelemetryProperty<TProperty extends Property> = TProperty extends { mode: "telemetry" }
  ? never
  : TProperty

// Distributes over the property union directly: probing a derived type instead would collapse the
// union and hand every id back, including primary and telemetry ones.
type SettablePropertyId<TProperty extends Property> = TProperty extends { primary: true }
  ? never
  : TProperty extends { mode: "telemetry" }
    ? never
    : TProperty["id"]

type CreatablePropertyId<TProperty extends Property> =
  NonTelemetryProperty<TProperty> extends never ? never : TProperty["id"]

/** Property ids an Action may set, unset, or reset — everything except primary and telemetry. */
export type EditablePropertyId<TObjectType extends ObjectType> =
  string extends TObjectType["properties"][number]["id"]
    ? string
    : SettablePropertyId<TObjectType["properties"][number]>

type StaticPropertyMap<
  TProperties extends readonly Property[],
  TValueTypes extends readonly ValueType[],
  TMode extends "create" | "update",
> = string extends TProperties[number]["id"]
  ? Record<string, unknown>
  : Simplify<{
      [TProp in TProperties[number] as TMode extends "create"
        ? CreatablePropertyId<TProp>
        : SettablePropertyId<TProp>]?: InferPropertyValue<TProp, TValueTypes>
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

  /** Clears managed values, leaving the property absent from managed authority. */
  unset(...propertyIds: readonly EditablePropertyId<TObjectType>[]): void

  /** Drops managed authority so source authority becomes visible again. */
  reset(...propertyIds: readonly EditablePropertyId<TObjectType>[]): void

  delete(): void

  restore(): void

  link<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>,
    ...options: EditLinkOptionsArg<TLinkToken, TValueTypes>
  ): void

  unlink<const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>>(
    link: TLinkToken,
    target: EditLinkTargetRef<TLinkToken>
  ): void

  /** Drops managed link authority so source link authority becomes visible again. */
  resetLink<
    const TLinkToken extends LinkToken<TObjectType["id"], string, string | readonly string[]>,
  >(link: TLinkToken, target: EditLinkTargetRef<TLinkToken>): void
}
