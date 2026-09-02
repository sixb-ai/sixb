import { linkRefKey, linkScopeKey, objectRefKey } from "../materialization/refs"
import type {
  EffectiveLinkSnapshot,
  ExpectedLinkRevision,
  ExpectedLinkScopeRevision,
  ExpectedObjectRevision,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../materializer"
import { createLinkScopeFingerprint } from "../materializer"
import { OntologyValidationError } from "../ontology/errors"
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import {
  assertPropertyTokenBelongsToObjectType,
  assertTelemetryProperty,
} from "../ontology/validation"
import { RuntimeError } from "../runtime/errors"
import type { ObjectSetListInput } from "../runtime/types"
import type {
  ObjectLinkRow,
  ObjectRow,
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
} from "../storage"
import type { ActionReadDependencies } from "./commit-edits"
import type {
  ActionReadFacade,
  ActionReadObjectSet,
  ActionTelemetryHistorySeriesInput,
  ActionTelemetryReadFacade,
} from "./types"

export type ActionReadObjectSetSource = {
  get(id: string): Promise<unknown>
  query(): unknown
  list(input?: ObjectSetListInput): Promise<unknown>
  byId(id: string): {
    get(): Promise<unknown>
    listLinks(link?: { readonly id: string }): Promise<unknown>
  }
}

/** Runtime leaves used by the Action telemetry read adapter. */
export interface ActionTelemetryReadSource {
  readonly resolveObjectType: (objectTypeId: string) => ObjectTypeWithPropertyTokens
  readonly getHistoryBatch: (
    input: Omit<TimeseriesHistoryBatchInput, "projectId">
  ) => Promise<readonly TimeseriesHistoryBatchResult[]>
}

/**
 * Records the exact state an Action handler observed while reading.
 *
 * A handler that reads one dependency twice keeps the first observation: the commit must fail when
 * current state no longer matches what the decision was made against, and the later read may already
 * reflect the handler's own intent. Arbitrary query phantoms stay out of this release — `query()` and
 * `list()` results are not turned into dependencies. Telemetry history is also a call-level snapshot,
 * not an edit dependency.
 */
export class ActionReadRecorder {
  private readonly objects = new Map<string, ExpectedObjectRevision>()
  private readonly links = new Map<string, ExpectedLinkRevision>()
  private readonly linkScopes = new Map<string, ExpectedLinkScopeRevision>()

  /** Records a concrete object read, including exact absence. */
  observeObject(ref: OntologyObjectRef, row: ObjectRow | null): void {
    const key = objectRefKey(ref)
    if (this.objects.has(key)) return
    if (!row) {
      this.objects.set(key, { ref, exists: false })
      return
    }
    // Rows without materializer provenance predate the commit ledger and cannot be fenced.
    if (row.lastCommitId === undefined) return
    this.objects.set(key, {
      ref,
      exists: true,
      version: row.version,
      lastCommitId: row.lastCommitId,
    })
  }

  /**
   * Records the complete `(source, linkId)` scopes a link listing observed.
   *
   * `linkIds` names every scope the read covered so an empty scope is recorded as an empty
   * fingerprint rather than being silently omitted.
   */
  observeLinkScopes(
    source: OntologyObjectRef,
    linkIds: readonly string[],
    rows: readonly ObjectLinkRow[]
  ): void {
    const snapshotsByLinkId = new Map<string, EffectiveLinkSnapshot[]>()
    for (const linkId of linkIds) snapshotsByLinkId.set(linkId, [])
    /** Scopes holding a row that cannot be fenced, so no expectation may be recorded for them. */
    const unfenceable = new Set<string>()

    for (const row of rows) {
      if (row.sourceTypeId !== source.objectTypeId || row.sourceId !== source.primaryId) continue
      const snapshots = snapshotsByLinkId.get(row.linkId)
      if (!snapshots) continue
      const snapshot = toLinkSnapshot(row)
      if (!snapshot) {
        // Same rule `observeObject` applies to rows without materializer provenance: record no
        // expectation at all. A fingerprint computed over the remaining rows would describe a scope
        // the store can never reproduce, turning every such read into a guaranteed conflict.
        unfenceable.add(row.linkId)
        continue
      }
      snapshots.push(snapshot)
      this.observeLink(snapshot.ref, snapshot)
    }

    for (const [linkId, snapshots] of snapshotsByLinkId) {
      if (unfenceable.has(linkId)) continue
      const key = linkScopeKey(source, linkId)
      if (this.linkScopes.has(key)) continue
      this.linkScopes.set(key, {
        source,
        linkId,
        fingerprint: createLinkScopeFingerprint(snapshots),
      })
    }
  }

  /** Records a concrete link read, including exact absence. */
  observeLink(ref: OntologyLinkRef, snapshot: EffectiveLinkSnapshot | null): void {
    const key = linkRefKey(ref)
    if (this.links.has(key)) return
    this.links.set(
      key,
      snapshot ? { ref, exists: true, lastCommitId: snapshot.lastCommitId } : { ref, exists: false }
    )
  }

  dependencies(): ActionReadDependencies {
    return {
      objects: [...this.objects.values()],
      links: [...this.links.values()],
      linkScopes: [...this.linkScopes.values()],
    }
  }
}

export interface ActionReadFacadeOptions {
  /** Records what the handler observed, so the commit can be fenced against it. */
  readonly recorder: ActionReadRecorder
  /**
   * Every link the object type carries, inherited links included.
   *
   * Inheritance is resolved by the Ontology registry, not by the imported definition, so an
   * `extends` type would otherwise report only its own links and drop inherited ones from the
   * recorded scopes.
   */
  readonly resolveLinkIds: (objectTypeId: string) => readonly string[]
  /** Canonical authorized telemetry history leaf. Omitted only by isolated facade consumers. */
  readonly telemetry?: ActionTelemetryReadSource
}

export function createActionReadFacade(
  createObjectSet: <const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ) => ActionReadObjectSetSource,
  options?: ActionReadFacadeOptions
): ActionReadFacade {
  const facade = {
    telemetry: createActionTelemetryReadFacade(options?.telemetry),
    objects<const TObjectType extends ObjectTypeWithPropertyTokens>(objectType: TObjectType) {
      return createActionReadObjectSetAdapter<TObjectType>(
        objectType,
        createObjectSet(objectType),
        options
      )
    },
  }

  return facade as ActionReadFacade
}

function createActionTelemetryReadFacade(
  source: ActionTelemetryReadSource | undefined
): ActionTelemetryReadFacade<readonly ValueType[]> {
  const facade = {
    async historyBatch(input: {
      readonly series: readonly ActionTelemetryHistorySeriesInput[]
      readonly from?: Date
      readonly to?: Date
      readonly limitPerSeries?: number
      readonly order?: "asc" | "desc"
    }) {
      if (!source) {
        throw new RuntimeError(
          "[Sixb] Action telemetry history requires a configured telemetry read source."
        )
      }
      if (input.series.length === 0) {
        return []
      }

      const requestedSeries = input.series.map((entry) => {
        const objectType = source.resolveObjectType(entry.property.objectTypeId)
        assertPropertyTokenBelongsToObjectType(objectType, entry.property)
        const registeredProperty = objectType.properties.find(
          (property) => property.id === entry.property.id
        )
        if (!registeredProperty) {
          throw new OntologyValidationError(
            `[Sixb] Unknown property '${entry.property.id}' for object type '${objectType.id}'`
          )
        }
        assertTelemetryProperty(registeredProperty)
        return {
          objectTypeId: objectType.id,
          objectId: entry.objectId,
          propertyId: registeredProperty.id,
        }
      })

      const results = await source.getHistoryBatch({
        series: requestedSeries,
        ...(input.from !== undefined ? { from: input.from } : {}),
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...(input.limitPerSeries !== undefined ? { limitPerSeries: input.limitPerSeries } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
      })
      assertTelemetryBatchResultMatchesRequest(requestedSeries, results)

      return input.series.map((entry, index) => ({
        objectId: entry.objectId,
        property: entry.property,
        points: results[index].points.map((point) => ({
          value: point.value,
          at: point.at,
          ...(point.unit !== undefined ? { unit: point.unit } : {}),
        })),
      }))
    },
  }

  // Cast needed at the generic token boundary: the implementation deliberately manipulates raw
  // provider values while the public facade maps every tuple position back to its property token.
  return facade as unknown as ActionTelemetryReadFacade<readonly ValueType[]>
}

function assertTelemetryBatchResultMatchesRequest(
  requested: readonly {
    readonly objectTypeId: string
    readonly objectId: string
    readonly propertyId: string
  }[],
  results: readonly TimeseriesHistoryBatchResult[]
): void {
  if (results.length !== requested.length) {
    throw new RuntimeError(
      `[Sixb] Telemetry history provider returned ${results.length} batch results for ${requested.length} requested series.`
    )
  }

  for (let index = 0; index < requested.length; index += 1) {
    const expected = requested[index]
    const actual = results[index]
    if (
      actual.objectTypeId !== expected.objectTypeId ||
      actual.objectId !== expected.objectId ||
      actual.propertyId !== expected.propertyId
    ) {
      throw new RuntimeError(
        `[Sixb] Telemetry history provider returned an unexpected series at batch index ${index}.`
      )
    }
  }
}

function createActionReadObjectSetAdapter<TObjectType extends ObjectTypeWithPropertyTokens>(
  objectType: TObjectType,
  objectSet: ActionReadObjectSetSource,
  options: ActionReadFacadeOptions | undefined
): ActionReadObjectSet<TObjectType, readonly ValueType[], ObjectTypeWithPropertyTokens> {
  type TypedReadObjectSet = ActionReadObjectSet<
    TObjectType,
    readonly ValueType[],
    ObjectTypeWithPropertyTokens
  >

  async function readObject(id: string, read: () => Promise<unknown>): Promise<unknown> {
    const row = await read()
    options?.recorder.observeObject(
      { objectTypeId: objectType.id, primaryId: id },
      (row ?? null) as ObjectRow | null
    )
    return row
  }

  return {
    get(id) {
      return readObject(id, () => objectSet.get(id)) as ReturnType<TypedReadObjectSet["get"]>
    },
    query() {
      return objectSet.query() as ReturnType<TypedReadObjectSet["query"]>
    },
    list(input) {
      return objectSet.list(input) as ReturnType<TypedReadObjectSet["list"]>
    },
    byId(id) {
      const handle = objectSet.byId(id)
      return {
        get() {
          return readObject(id, () => handle.get()) as ReturnType<
            ReturnType<TypedReadObjectSet["byId"]>["get"]
          >
        },
        async listLinks(link) {
          const rows = (await handle.listLinks(link)) as readonly ObjectLinkRow[]
          options?.recorder.observeLinkScopes(
            { objectTypeId: objectType.id, primaryId: id },
            link ? [link.id] : options.resolveLinkIds(objectType.id),
            rows
          )
          return rows as unknown as Awaited<
            ReturnType<ReturnType<TypedReadObjectSet["byId"]>["listLinks"]>
          >
        },
      }
    },
  }
}

function toLinkSnapshot(row: ObjectLinkRow): EffectiveLinkSnapshot | null {
  // Rows without materializer provenance predate the commit ledger and cannot be fenced.
  if (row.lastCommitId === undefined) return null
  return {
    ref: {
      source: { objectTypeId: row.sourceTypeId, primaryId: row.sourceId },
      linkId: row.linkId,
      target: { objectTypeId: row.targetTypeId, primaryId: row.targetId },
    },
    ...(row.properties !== undefined
      ? { properties: row.properties as EffectiveLinkSnapshot["properties"] }
      : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastCommitId: row.lastCommitId,
  }
}
