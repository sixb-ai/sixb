import type { OntologyObjectRef } from "../../../materialization/model"
import { linkRefKey, linkScopeKey, objectRefKey } from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import { type SnapshotLoadBatch, snapshotEditedAt } from "../../snapshots"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type { OntologyCommitRecord } from "../commits"
import type { StoredObjectVector } from "../vectors"
import { emptyCommitTouches } from "./replacement-plans"
import {
  commitKey,
  commitOriginKey,
  type InMemoryOntologyState,
  idempotencyKey,
  ontologyCommitOriginSelector,
  projectEntityKey,
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

  readVectors(projectId: string, refs: readonly OntologyObjectRef[]): StoredObjectVector[] {
    return refs.flatMap((ref) => [
      ...(this.state.vectors.get(vectorObjectKey(projectId, ref))?.values() ?? []),
    ])
  }
}
