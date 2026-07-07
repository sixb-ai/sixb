import type { ConnectorAdapter, ConnectorClient, ConnectorDefinition } from "../../connectors"
import type { EditCommitDiff, RecordEditsContext } from "../../edits"
import type { ObjectType, ValueType } from "../../ontology"
import type { LinkToken, ObjectTypeWithPropertyTokens } from "../../ontology/tokens"
import type {
  ListResult,
  ObjectQueryBuilder,
  ObjectSetListInput,
  TwinObject,
} from "../../runtime/types"
import type { ActionPrimitiveSchemaValues } from "./params"

export type ActionTargetObject<
  TObjectType extends ObjectType = ObjectType,
  _TValueTypes extends readonly ValueType[] = readonly ValueType[],
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

export type ActionSubject = { readonly kind: "none" } | ActionObjectSubject

export type ActionObjectSubject<TObjectType extends ObjectType = ObjectType> = {
  readonly kind: "object"
  readonly objectTypeId: TObjectType["id"]
  readonly primaryId: string
}

export type ActionBinding<TObjectType extends ObjectType = ObjectType> =
  | { readonly kind: "global" }
  | { readonly kind: "object"; readonly objectType: TObjectType }

type ActionLinkTokenForObjectType<TObjectType extends ObjectTypeWithPropertyTokens> = LinkToken<
  TObjectType["id"],
  TObjectType["links"][number]["id"],
  TObjectType["links"][number]["targetObjectTypeId"],
  TObjectType["links"][number]
>

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
  listLinks(link?: ActionLinkTokenForObjectType<TObjectType>): Promise<
    readonly {
      readonly linkId: string
      readonly targetTypeId: string
      readonly targetId: string
      readonly properties?: Readonly<Record<string, unknown>>
    }[]
  >
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

export interface ActionReadFacade<TValueTypes extends readonly ValueType[] = readonly ValueType[]> {
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionReadObjectSet<TObjectType, TValueTypes, ObjectTypeWithPropertyTokens>
}

export interface ActionTelemetryObjectSet<
  _TObjectType extends ObjectTypeWithPropertyTokens,
  _TValueTypes extends readonly ValueType[],
> {
  appendTelemetryBatch(
    items: readonly {
      id: string
      properties: Readonly<Record<string, unknown>>
      at?: Date
    }[]
  ): Promise<void>
}

export interface ActionRuntimeFacade<
  TValueTypes extends readonly ValueType[] = readonly ValueType[],
> {
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionTelemetryObjectSet<TObjectType, TValueTypes>
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
  readonly read: ActionReadFacade
}

export interface ActionWritebackContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
> extends BaseActionPhaseContext<TParams> {
  readonly sixb: ActionRuntimeFacade
  readonly target: ActionTargetObject<TObjectType>
  readonly read: ActionReadFacade
}

export interface GlobalActionEditsContext<TParams extends Record<string, unknown>, TWriteback>
  extends BaseActionPhaseContext<TParams> {
  readonly objects: RecordEditsContext["objects"]
  readonly read: ActionReadFacade
  readonly writeback: TWriteback
}

export interface ActionEditsContext<
  TObjectType extends ObjectTypeWithPropertyTokens,
  TParams extends Record<string, unknown>,
  TWriteback,
> extends Omit<BaseActionPhaseContext<TParams>, "subject"> {
  readonly subject: ActionObjectSubject<TObjectType>
  readonly objects: RecordEditsContext["objects"]
  readonly read: ActionReadFacade
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
> extends Omit<BaseActionPhaseContext<TParams>, "subject"> {
  readonly subject: ActionObjectSubject<TObjectType>
  readonly sixb: ActionRuntimeFacade
  readonly commit: ActionPhaseCommit
  readonly writeback: TWriteback
}
