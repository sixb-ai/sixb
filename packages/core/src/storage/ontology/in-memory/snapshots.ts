import type { OntologyObjectRef } from "../../../materialization/model"
import {
  linkRefKey,
  linkScopeKey,
  linkScopeSortKey,
  objectRefKey,
  projectionEntityKey,
} from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import {
  type SnapshotLoadBatch,
  type SnapshotSourceRoot,
  type SnapshotSourceRootWrite,
  type SnapshotSourceWrite,
  type SnapshotTypeEdits,
  snapshotEditedAt,
} from "../../snapshots"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type { OntologyCommitRecord } from "../commits"
import type { StoredSourceAssertion, StoredSourceLinkAssertion } from "../sources"
import type { StoredObjectVector } from "../vectors"
import { emptyCommitTouches } from "./replacement-plans"
import {
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  type InMemorySourceMaterialization,
  idempotencyKey,
  ontologyCommitOriginSelector,
  projectEntityKey,
  sourceMaterializationKey,
} from "./shared-state"
import { vectorObjectKey } from "./vectors"

/** What a snapshot reads from the in-memory state, and how one loads into it. */
export class InMemorySnapshots {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly timeseries: InMemoryTimeseriesStorage
  ) {}

  commit(record: OntologyCommitRecord): void {
    const { projectId, id } = record
    this.state.commitsById.set(commitKey(projectId, id), structuredClone(record))
    this.state.commitTouches.set(this.state.commitsById.size, emptyCommitTouches(projectId))
    this.state.commitIdByIdempotency.set(idempotencyKey(projectId, record.idempotencyKey), id)

    const origin = ontologyCommitOriginSelector(record.origin)
    if (origin) this.state.commitIdByOrigin.set(commitOriginKey(projectId, origin), id)
  }

  write(projectId: string, commit: OntologyCommitRecord, batch: SnapshotLoadBatch): void {
    const objects = getInMemoryObjectMaterializerAdapter(this.objects)
    const lastCommitId = commit.id

    for (const source of batch.sources ?? []) this.writeSource(projectId, commit, source)
    for (const root of batch.sourceRoots ?? []) this.writeSourceRoot(projectId, root)
    if (batch.edits) this.writeEdits(projectId, commit, batch.edits)

    for (const object of batch.objects ?? []) {
      const ref = { objectTypeId: object.objectTypeId, primaryId: object.primaryId }
      objects.applyExactObject(
        {
          ref,
          properties: object.properties,
          version: 1,
          createdAt: object.createdAt,
          updatedAt: object.updatedAt,
          lastCommitId,
        },
        projectId
      )
      if (!object.override) continue
      this.state.objectOverrides.set(projectEntityKey(projectId, objectRefKey(ref)), {
        projectId,
        ref,
        value: structuredClone(object.override),
        editedAt: snapshotEditedAt(object.override.properties, object.updatedAt),
        lastCommitId,
        updatedAt: object.updatedAt,
      })
    }

    for (const link of batch.links ?? []) {
      const ref = {
        source: { objectTypeId: link.sourceTypeId, primaryId: link.sourceId },
        linkId: link.linkId,
        target: { objectTypeId: link.targetTypeId, primaryId: link.targetId },
      }
      const properties = link.properties === undefined ? {} : { properties: link.properties }
      objects.applyExactLink(
        { ref, ...properties, createdAt: link.createdAt, updatedAt: link.updatedAt, lastCommitId },
        projectId
      )

      if (link.identity === "source") continue
      if (link.identity === "slot") {
        this.state.linkSlotOverrides.set(
          projectEntityKey(projectId, linkScopeKey(ref.source, ref.linkId)),
          {
            projectId,
            ref: { source: ref.source, linkId: ref.linkId },
            value: structuredClone({ kind: "set", target: ref.target, ...properties }),
            lastCommitId,
            updatedAt: link.updatedAt,
          }
        )
      } else {
        this.state.linkOverrides.set(projectEntityKey(projectId, linkRefKey(ref)), {
          projectId,
          ref,
          value: structuredClone({ kind: "upsert", ...properties }),
          lastCommitId,
          updatedAt: link.updatedAt,
        })
      }
    }

    const timeseries = getInMemoryTimeseriesMaterializerAdapter(this.timeseries)
    for (const point of batch.points ?? []) {
      timeseries.applyExactPoint(projectId, {
        series: {
          object: { objectTypeId: point.objectTypeId, primaryId: point.objectId },
          propertyId: point.propertyId,
        },
        value: structuredClone(point.value),
        ...(point.unit === undefined ? {} : { unit: point.unit }),
        at: point.at,
        lastCommitId,
      })
    }

    for (const claim of batch.uniqueValues ?? []) objects.claimUniqueValue(projectId, claim)
    for (const holder of batch.artifactHolders ?? [])
      objects.insertArtifactHolder(projectId, holder)

    for (const vector of batch.vectors ?? []) {
      const key = vectorObjectKey(projectId, vector.ref)
      const profiles = this.state.vectors.get(key) ?? new Map<string, StoredObjectVector>()
      profiles.set(vector.profile, structuredClone(vector))
      this.state.vectors.set(key, profiles)
    }
  }

  /** Live roots of a projection's active source, in root key order, as bytes compare. */
  readSourceRoots(
    projectId: string,
    projectionId: string,
    afterRootKey: string | undefined,
    limit: number
  ): SnapshotSourceRoot[] {
    const active = this.state.activeSourceRoots.get(projectEntityKey(projectId, projectionId))
    if (!active) return []

    const after = afterRootKey === undefined ? undefined : Buffer.from(afterRootKey)
    const keys = [...active.keys()]
      .map((rootKey) => ({ rootKey, bytes: Buffer.from(rootKey) }))
      .filter((key) => after === undefined || Buffer.compare(key.bytes, after) > 0)
      .sort((left, right) => Buffer.compare(left.bytes, right.bytes))
      .slice(0, limit)

    return keys.map(({ rootKey }) => {
      const materialization = this.state.sourceMaterializations.get(
        sourceMaterializationKey(projectId, projectionId, active.get(rootKey)!)
      )!
      const root = materialization.roots.get(rootKey)!
      return {
        rootKey,
        root: structuredClone(root.root),
        assertions: [...root.entityKeys].map((entityKey) =>
          structuredClone(materialization.rowsByEntity.get(entityKey)!.assertion)
        ),
      }
    })
  }

  /** Every edit over a type's objects and the links from them. */
  readEdits(projectId: string, objectTypeId: string): SnapshotTypeEdits {
    const own = <T extends { readonly projectId: string }>(rows: Iterable<T>) =>
      [...rows].filter((row) => row.projectId === projectId)

    return structuredClone({
      objects: own(this.state.objectOverrides.values())
        .filter((row) => row.ref.objectTypeId === objectTypeId)
        .map(({ ref, value, editedAt, updatedAt }) => ({
          ref,
          value,
          ...(editedAt === undefined ? {} : { editedAt }),
          updatedAt,
        })),
      links: own(this.state.linkOverrides.values())
        .filter((row) => row.ref.source.objectTypeId === objectTypeId)
        .map(({ ref, value, updatedAt }) => ({ ref, value, updatedAt })),
      slots: own(this.state.linkSlotOverrides.values())
        .filter((row) => row.ref.source.objectTypeId === objectTypeId)
        .map(({ ref, value, updatedAt }) => ({
          source: ref.source,
          linkId: ref.linkId,
          value,
          updatedAt,
        })),
    })
  }

  /** A source taken over from production: active as of the base commit, with no root yet. */
  private writeSource(
    projectId: string,
    commit: OntologyCommitRecord,
    source: SnapshotSourceWrite
  ): void {
    const at = commit.committedAt
    const materialization: InMemorySourceMaterialization = {
      projectId,
      source: { projectionId: source.projectionId },
      materializationId: source.materializationId,
      projectionRunId: commit.id,
      projectionKind: "object",
      protocol: "replacement",
      status: "active",
      executionToken: null,
      datasetVersion: structuredClone(source.datasetVersion),
      projectionRevision: source.projectionRevision,
      ownershipHash: source.ownershipHash,
      ontologyRevision: source.ontologyRevision,
      rootCount: 0,
      assertionCount: 0,
      createdAt: at,
      readyAt: at,
      activatedAt: at,
      terminalAt: null,
      lastCommitId: commit.id,
      updatedAt: at,
      roots: new Map(),
      rowsByEntity: new Map(),
      rootOrdinals: new Map(),
      ordinalRoots: new Map(),
    }
    const sourceKey = projectEntityKey(projectId, source.projectionId)
    this.state.sourceMaterializations.set(
      sourceMaterializationKey(projectId, source.projectionId, source.materializationId),
      materialization
    )
    this.state.activeSourceHeads.set(sourceKey, source.materializationId)
    this.state.activeSourceRoots.set(sourceKey, new Map())
  }

  /** One live root of a source taken over, indexed as an activation indexes it. */
  private writeSourceRoot(projectId: string, write: SnapshotSourceRootWrite): void {
    const { projectionId, materializationId, rootKey } = write
    const key = sourceMaterializationKey(projectId, projectionId, materializationId)
    const materialization = this.state.sourceMaterializations.get(key)!
    const entityKeys = new Set<string>()

    for (const assertion of write.assertions) {
      const entityKey = projectionEntityKey(assertion)
      entityKeys.add(entityKey)
      const row = {
        root: structuredClone(write.root),
        assertion: structuredClone(assertion),
        stagingOrdinal: write.stagingOrdinal,
      }
      materialization.rowsByEntity.set(entityKey, row)

      const stored = {
        source: { projectionId },
        materializationId,
        ...row,
      } as StoredSourceAssertion
      const indexKey = projectEntityKey(projectId, entityKey)
      const sources = this.state.activeSourceRows.get(indexKey) ?? new Map()
      this.state.activeSourceRows.set(indexKey, sources.set(projectionId, stored))

      if (assertion.kind === "link") {
        const scopeKey = projectEntityKey(
          projectId,
          linkScopeSortKey(assertion.ref.source, assertion.ref.linkId)
        )
        const scope = this.state.activeSourceLinkScopes.get(scopeKey) ?? new Map()
        scope.set(JSON.stringify([projectionId, entityKey]), stored as StoredSourceLinkAssertion)
        this.state.activeSourceLinkScopes.set(scopeKey, scope)
      }
    }

    materialization.roots.set(rootKey, {
      root: structuredClone(write.root),
      stagingOrdinal: write.stagingOrdinal,
      deleted: false,
      entityKeys,
      active: true,
      retiredAt: null,
    })
    materialization.rootOrdinals.set(rootKey, write.stagingOrdinal)
    materialization.ordinalRoots.set(write.stagingOrdinal, rootKey)
    this.state.activeSourceRoots
      .get(projectEntityKey(projectId, projectionId))!
      .set(rootKey, materializationId)
    this.state.sourceMaterializations.set(key, {
      ...materialization,
      rootCount: (materialization.rootCount ?? 0) + 1,
      assertionCount: (materialization.assertionCount ?? 0) + write.assertions.length,
    })
  }

  private writeEdits(projectId: string, commit: OntologyCommitRecord, edits: SnapshotTypeEdits) {
    const lastCommitId = commit.id

    for (const edit of edits.objects) {
      this.state.objectOverrides.set(projectEntityKey(projectId, objectRefKey(edit.ref)), {
        projectId,
        ...structuredClone(edit),
        lastCommitId,
      })
    }
    for (const edit of edits.links) {
      this.state.linkOverrides.set(projectEntityKey(projectId, linkRefKey(edit.ref)), {
        projectId,
        ...structuredClone(edit),
        lastCommitId,
      })
    }
    for (const edit of edits.slots) {
      this.state.linkSlotOverrides.set(
        projectEntityKey(projectId, linkScopeKey(edit.source, edit.linkId)),
        {
          projectId,
          ref: structuredClone({ source: edit.source, linkId: edit.linkId }),
          value: structuredClone(edit.value),
          lastCommitId,
          updatedAt: edit.updatedAt,
        }
      )
    }
  }

  readVectors(projectId: string, refs: readonly OntologyObjectRef[]): StoredObjectVector[] {
    return refs.flatMap((ref) => [
      ...(this.state.vectors.get(vectorObjectKey(projectId, ref))?.values() ?? []),
    ])
  }
}
