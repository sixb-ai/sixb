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
import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type { ValueType } from "../ontology/types"
import type { ObjectSetListInput } from "../runtime/types"
import type { ObjectLinkRow, ObjectRow } from "../storage"
import type { ActionReadDependencies } from "./commit-edits"
import type { ActionReadFacade, ActionReadObjectSet } from "./types"

export type ActionReadObjectSetSource = {
  get(id: string): Promise<unknown>
  query(): unknown
  list(input?: ObjectSetListInput): Promise<unknown>
  byId(id: string): {
    get(): Promise<unknown>
    listLinks(link?: { readonly id: string }): Promise<unknown>
  }
}

/**
 * Records the exact state an Action handler observed while reading.
 *
 * A handler that reads one dependency twice keeps the first observation: the commit must fail when
 * current state no longer matches what the decision was made against, and the later read may already
 * reflect the handler's own intent. Arbitrary query phantoms stay out of this release — `query()` and
 * `list()` results are not turned into dependencies.
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

    for (const row of rows) {
      if (row.sourceTypeId !== source.objectTypeId || row.sourceId !== source.primaryId) continue
      const snapshots = snapshotsByLinkId.get(row.linkId)
      if (!snapshots) continue
      const snapshot = toLinkSnapshot(row)
      if (!snapshot) continue
      snapshots.push(snapshot)
      this.observeLink(snapshot.ref, snapshot)
    }

    for (const [linkId, snapshots] of snapshotsByLinkId) {
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
}

export function createActionReadFacade(
  createObjectSet: <const TObjectType extends ObjectTypeWithPropertyTokens>(
    objectType: TObjectType
  ) => ActionReadObjectSetSource,
  options?: ActionReadFacadeOptions
): ActionReadFacade {
  const facade = {
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
