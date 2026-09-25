import type { BlobStorage } from "../../blob-storage"
import type { ConnectorRuntime } from "../../connectors"
import type { RecordEditsContext } from "../../edits"
import type { Logger } from "../../logging"
import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyOperationOutcome,
} from "../../materializer"
import type { ModelsRuntime } from "../../models/generation-types"
import type { ObjectType, Property } from "../../ontology"
import type { InferPropertyUnit, InferPropertyValue } from "../../ontology/inference"
import type { LinkToken, ObjectTypeWithPropertyTokens, PropertyToken } from "../../ontology/tokens"
import type {
  ListResult,
  ObjectQueryBuilder,
  ObjectSetListInput,
  TwinObject,
} from "../../runtime/types"
import type { ActionPrimitiveSchemaValues } from "./params"

export type ActionTargetObject<TObjectType extends ObjectType = ObjectType> = {
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

export interface ActionReadObjectByIdHandle<TObjectType extends ObjectTypeWithPropertyTokens> {
  get(): Promise<TwinObject<TObjectType> | null>
  listLinks(link?: ActionLinkTokenForObjectType<TObjectType>): Promise<
    readonly {
      readonly linkId: string
      readonly targetTypeId: string
      readonly targetId: string
      readonly properties?: Readonly<Record<string, unknown>>
    }[]
  >
}

export interface ActionReadObjectSet<TObjectType extends ObjectTypeWithPropertyTokens> {
  get(id: string): Promise<TwinObject<TObjectType> | null>
  query(): ObjectQueryBuilder<TObjectType>
  list(input?: ObjectSetListInput): Promise<ListResult<TwinObject<TObjectType>>>
  byId(id: string): ActionReadObjectByIdHandle<TObjectType>
}

/** A telemetry-mode ontology property accepted by Action history reads. */
export type ActionTelemetryPropertyToken = PropertyToken<
  string,
  string,
  Property & { readonly mode: "telemetry" }
>

export type ActionTelemetryHistorySeriesInput<
  TProperty extends ActionTelemetryPropertyToken = ActionTelemetryPropertyToken,
> = {
  readonly objectId: string
  readonly property: TProperty
}

export interface ActionTelemetryHistoryBatchInput<
  TSeries extends
    readonly ActionTelemetryHistorySeriesInput[] = readonly ActionTelemetryHistorySeriesInput[],
> {
  /** Series are returned in this exact order, including duplicate entries. */
  readonly series: TSeries
  readonly from?: Date
  readonly to?: Date
  /** Optional cap applied independently to every requested series. */
  readonly limitPerSeries?: number
  /** Points are oldest first by default. */
  readonly order?: "asc" | "desc"
}

/**
 * One batch result per requested series, preserving tuple positions and property-specific types.
 */
export type ActionTelemetryHistoryBatchResult<
  TSeries extends
    readonly ActionTelemetryHistorySeriesInput[] = readonly ActionTelemetryHistorySeriesInput[],
> = {
  readonly [TIndex in keyof TSeries]: TSeries[TIndex] extends ActionTelemetryHistorySeriesInput<
    infer TProperty
  >
    ? {
        readonly objectId: TSeries[TIndex]["objectId"]
        readonly property: TProperty
        readonly points: readonly {
          readonly value: InferPropertyValue<TProperty["property"]>
          readonly at: Date
          readonly unit?: InferPropertyUnit<TProperty["property"]>
        }[]
      }
    : never
}

export type ActionTelemetryReadFacade = {
  /**
   * Read several telemetry series in one provider call.
   *
   * This is a snapshot read for the call. It is intentionally not added to the Action edit
   * dependency fence; use a fixed `to` cutoff to keep the report window stable across retries.
   */
  historyBatch<const TSeries extends readonly ActionTelemetryHistorySeriesInput[]>(
    input: ActionTelemetryHistoryBatchInput<TSeries>
  ): Promise<ActionTelemetryHistoryBatchResult<TSeries>>
}

export interface ActionReadFacade {
  readonly telemetry: ActionTelemetryReadFacade
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionReadObjectSet<TObjectType>
}

export interface ActionTelemetryObjectSet<_TObjectType extends ObjectTypeWithPropertyTokens> {
  appendTelemetryBatch(
    items: readonly {
      id: string
      properties: Readonly<Record<string, unknown>>
      at?: Date
    }[]
  ): Promise<void>
}

/** Immutable blob operations available to action writeback and effects handlers. */
export type ActionBlobContext = Pick<BlobStorage, "put" | "open" | "stat">

export interface ActionRuntimeFacade {
  readonly blobs: ActionBlobContext
  readonly models: ModelsRuntime
  readonly connector: ConnectorRuntime
  objects<const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ): ActionTelemetryObjectSet<TObjectType>
}

/**
 * The authoritative ontology commit the run's edits produced.
 *
 * Domain events are already durable outbox facts, so effects consume this persisted result rather
 * than reconstructed event drafts.
 */
export interface ActionPhaseCommit {
  readonly commitId: string
  readonly created: boolean
  readonly outcomes: readonly OntologyOperationOutcome[]
  readonly changes: {
    readonly objects: readonly EffectiveObjectChange[]
    readonly links: readonly EffectiveLinkChange[]
  }
  readonly committedAt: Date
}

export interface BaseActionPhaseContext<TParams extends Record<string, unknown>> {
  readonly run: ActionRunPhaseInfo
  readonly params: TParams
  readonly subject: ActionSubject
  readonly signal: AbortSignal
  readonly logger: Logger
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
