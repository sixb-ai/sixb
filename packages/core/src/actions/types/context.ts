import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "../../connectors"
import type { EditBuilder, EditCommitDiff, EditObjectHandle } from "../../edits"
import type { ObjectRef, ObjectType, ValueType } from "../../ontology"
import type { InferObjectProperties, InferTelemetryBatchProperties } from "../../ontology/inference"
import type { ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type {
  ListResult,
  ObjectQueryBuilder,
  ObjectSetListInput,
  TwinObject,
} from "../../runtime/types"
import type { ActionPrimitiveSchemaValues } from "./params"

type ObjectTypeShape<TObjectType extends ObjectType> = {
  readonly id: TObjectType["id"]
  readonly name: TObjectType["name"]
  readonly description?: TObjectType["description"]
  readonly properties: TObjectType["properties"]
  readonly links: TObjectType["links"]
  readonly extends?: TObjectType["extends"]
}

export type ActionTargetObject<
  TObjectType extends ObjectType = ObjectType,
  _TValueTypes extends readonly ValueType[] = [],
> = {
  readonly primaryId: string
  readonly objectTypeId: TObjectType["id"]
  readonly properties: ActionTargetPropertyBag<TObjectType>
  readonly createdAt: Date
  readonly updatedAt: Date
}

type ActionTargetPropertyBag<TObjectType extends ObjectType> = TObjectType extends {
  readonly p: infer TPropertyTokens
}
  ? string extends keyof TPropertyTokens
    ? Record<string, unknown>
    : {
        readonly [K in keyof TPropertyTokens]: InferActionSnapshotPropertyValue<TPropertyTokens[K]>
      }
  : Record<string, unknown>

type InferActionSnapshotPropertyValue<TPropertyToken> = TPropertyToken extends {
  readonly property: { readonly schema: infer TSchema }
}
  ? TPropertyToken extends { readonly property: { readonly nullable: true } }
    ? InferActionSnapshotSchemaValue<TSchema> | null
    : InferActionSnapshotSchemaValue<TSchema>
  : unknown

type InferActionSnapshotSchemaValue<TSchema> = TSchema extends keyof ActionPrimitiveSchemaValues
  ? ActionPrimitiveSchemaValues[TSchema]
  : TSchema extends { readonly type: "enum"; readonly values: readonly (infer TValue)[] }
    ? TValue
    : unknown

export type ActionSubject =
  | { readonly kind: "none" }
  | { readonly kind: "object"; readonly objectTypeId: string; readonly primaryId: string }

export type ActionBinding<TObjectType extends ObjectType = ObjectType> =
  | { readonly kind: "global" }
  | { readonly kind: "object"; readonly objectType: TObjectType }

export interface ActionRunPhaseInfo {
  readonly id: string
  readonly startedAt: Date
  readonly idempotencyKey: string
}

export interface ActionReadObjectByIdHandle<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  get(): Promise<TwinObject<TObjectType, TValueTypes> | null>
}

export interface ActionReadObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
  TRegisteredObjectTypes extends ObjectTypeWithPropertyTokens = TObjectType,
> {
  get(id: string): Promise<TwinObject<TObjectType, TValueTypes> | null>
  query(): ObjectQueryBuilder<TObjectType, TRegisteredObjectTypes, TValueTypes>
  list(input?: ObjectSetListInput): Promise<ListResult<TwinObject<TObjectType, TValueTypes>>>
  byId(id: string): ActionReadObjectByIdHandle<TObjectType, TValueTypes>
}

export interface ActionReadFacade<TValueTypes extends readonly ValueType[] = []> {
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionReadObjectSet<TObjectType, TValueTypes, ObjectTypeWithPropertyTokens>
}

export interface ActionRuntimeObjectSet<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TValueTypes extends readonly ValueType[],
> {
  get(id: string): Promise<TwinObject<ObjectTypeShape<TObjectType>, TValueTypes> | null>
  upsert(input: {
    properties: InferObjectProperties<ObjectTypeShape<TObjectType>, TValueTypes>
  }): Promise<TwinObject<ObjectTypeShape<TObjectType>, TValueTypes>>
  appendTelemetryBatch(
    items: readonly {
      id: string
      properties: InferTelemetryBatchProperties<ObjectTypeShape<TObjectType>, TValueTypes>
      at?: Date
    }[]
  ): Promise<void>
}

export interface ActionRuntimeFacade<TValueTypes extends readonly ValueType[] = []> {
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionRuntimeObjectSet<TObjectType, TValueTypes>
  connector<TAdapter extends ConnectorAdapter>(
    definition: ConnectorDefinition<string, TAdapter>
  ): Promise<ConnectorClient<TAdapter>>
}

export interface ActionPhaseCommit {
  readonly diff: EditCommitDiff
  readonly committedAt: Date
  readonly created: boolean
}

export interface BaseActionPhaseContext<TParams extends Record<string, unknown>> {
  readonly run: ActionRunPhaseInfo
  readonly params: TParams
  readonly subject: ActionSubject
  readonly signal: AbortSignal
}

export interface GlobalActionValidationContext<TParams extends Record<string, unknown>>
  extends BaseActionPhaseContext<TParams> {}

export interface ActionValidationContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
> extends BaseActionPhaseContext<TParams> {
  readonly target: ActionTargetObject<TObjectType>
}

export interface GlobalActionWritebackContext<TParams extends Record<string, unknown>>
  extends BaseActionPhaseContext<TParams> {
  readonly sixb: ActionRuntimeFacade
}

export interface ActionWritebackContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
> extends BaseActionPhaseContext<TParams> {
  readonly sixb: ActionRuntimeFacade
  readonly target: ActionTargetObject<TObjectType>
}

export interface GlobalActionEditsContext<TParams extends Record<string, unknown>, TWriteback>
  extends BaseActionPhaseContext<TParams> {
  readonly edit: EditBuilder
  readonly read: ActionReadFacade
  readonly writeback: TWriteback
}

export interface ActionEditsContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
> extends BaseActionPhaseContext<TParams> {
  readonly edit: EditBuilder
  readonly read: ActionReadFacade
  readonly target: EditObjectHandle<TObjectType>
  readonly writeback: TWriteback
}

export interface GlobalActionEffectsContext<TParams extends Record<string, unknown>, TWriteback>
  extends BaseActionPhaseContext<TParams> {
  readonly sixb: ActionRuntimeFacade
  readonly commit: ActionPhaseCommit
  readonly writeback: TWriteback
}

export interface ActionEffectsContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
> extends BaseActionPhaseContext<TParams> {
  readonly sixb: ActionRuntimeFacade
  readonly commit: ActionPhaseCommit
  readonly target: ObjectRef<ObjectTypeShape<TObjectType>["id"]>
  readonly writeback: TWriteback
}
