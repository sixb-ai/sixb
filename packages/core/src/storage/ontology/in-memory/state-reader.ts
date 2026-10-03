import { MaterializationConflictError } from "../../../materialization/errors"
import type { OntologyLinkRef, OntologyObjectRef } from "../../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeKey,
  linkScopeSortKey,
  objectRefKey,
  projectionEntityKey,
} from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type { ObjectLinkRow } from "../../objects/types"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type {
  MaterializationLinkScopeRevision,
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  StoredTelemetryPoint,
} from "../materializations"
import { appendScopeSnapshot, finishScopeAccumulator, startScopeAccumulator } from "../provider"
import type {
  StoredSourceAssertion,
  StoredSourceLinkAssertion,
  StoredSourceObjectAssertion,
} from "../sources"
import {
  linkRef,
  linkSnapshot,
  objectSnapshot,
  publicLinkOverride,
  publicLinkSlotOverride,
  publicObjectOverride,
  storedPoint,
} from "./materializations-state"
import {
  type InMemoryOntologyState,
  type InMemoryOntologyStorageTestHooks,
  projectEntityKey,
} from "./shared-state"

/** Reads one project's current ontology state for materialization sessions and plans. */
export class InMemoryMaterializationStateReader {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly timeseries: InMemoryTimeseriesStorage,
    private readonly hooks: InMemoryOntologyStorageTestHooks = {}
  ) {}

  async objectState(
    projectId: string,
    ref: OntologyObjectRef
  ): Promise<MaterializationObjectState> {
    const row = await this.objects.getByPrimaryId({
      projectId,
      objectTypeId: ref.objectTypeId,
      primaryId: ref.primaryId,
    })
    return {
      ref: structuredClone(ref),
      source: this.findActiveObjectSource(projectId, ref),
      override: structuredClone(
        publicObjectOverride(
          this.state.objectOverrides.get(projectEntityKey(projectId, objectRefKey(ref)))
        )
      ),
      effective: row ? objectSnapshot(row) : null,
      latestTelemetry: getInMemoryTimeseriesMaterializerAdapter(this.timeseries)
        .listLatestForObject(projectId, ref.objectTypeId, ref.primaryId)
        .map(storedPoint),
    }
  }

  latestTelemetry(projectId: string, ref: OntologyObjectRef): StoredTelemetryPoint[] {
    return getInMemoryTimeseriesMaterializerAdapter(this.timeseries)
      .listLatestForObject(projectId, ref.objectTypeId, ref.primaryId)
      .map(storedPoint)
  }

  async linkState(projectId: string, ref: OntologyLinkRef): Promise<MaterializationLinkState> {
    const row = getInMemoryObjectMaterializerAdapter(this.objects).getExactLinkRow(projectId, {
      sourceTypeId: ref.source.objectTypeId,
      sourceId: ref.source.primaryId,
      linkId: ref.linkId,
      targetTypeId: ref.target.objectTypeId,
      targetId: ref.target.primaryId,
    })
    return {
      ref: structuredClone(ref),
      source: this.findActiveLinkSource(projectId, ref),
      override: structuredClone(
        publicLinkOverride(
          this.state.linkOverrides.get(projectEntityKey(projectId, linkRefKey(ref)))
        )
      ),
      slotOverride: structuredClone(
        publicLinkSlotOverride(
          this.state.linkSlotOverrides.get(
            projectEntityKey(projectId, linkScopeKey(ref.source, ref.linkId))
          )
        )
      ),
      effective: row ? linkSnapshot(row) : null,
    }
  }

  linkSlotState(
    projectId: string,
    source: OntologyObjectRef,
    linkId: string
  ): MaterializationLinkScopeState {
    const value = this.effectiveLinkScope(projectId, source, linkId)
    return {
      ...value,
      sourceAssertion: this.findActiveLinkScopeSource(projectId, source, linkId),
      override: structuredClone(
        publicLinkSlotOverride(
          this.state.linkSlotOverrides.get(
            projectEntityKey(projectId, linkScopeKey(source, linkId))
          )
        )
      ),
    }
  }

  effectiveLinkScope(
    projectId: string,
    source: OntologyObjectRef,
    linkId: string
  ): MaterializationLinkScopeRevision & Pick<MaterializationLinkScopeState, "effective"> {
    const rows: ObjectLinkRow[] = []
    getInMemoryObjectMaterializerAdapter(this.objects).visitExactScopeLinks(
      projectId,
      source.objectTypeId,
      source.primaryId,
      linkId,
      (row) => rows.push(row)
    )
    rows.sort((left, right) =>
      linkRefSortKey(linkRef(left)).localeCompare(linkRefSortKey(linkRef(right)))
    )
    const accumulator = startScopeAccumulator(source, linkId)
    for (let offset = 0; offset < rows.length; offset += 1_000) {
      const page = rows.slice(offset, offset + 1_000)
      this.hooks.observeBuffer?.("state.link-scope.page", page.length)
      for (const row of page) {
        appendScopeSnapshot(accumulator, linkSnapshot(row))
      }
    }
    const effective = rows.length === 1 ? linkSnapshot(rows[0]!) : null
    return {
      ...finishScopeAccumulator(accumulator),
      effective,
    }
  }

  findActiveLinkScopeSource(
    projectId: string,
    source: OntologyObjectRef,
    linkId: string
  ): StoredSourceLinkAssertion | null {
    const rows = this.state.activeSourceLinkScopes.get(
      projectEntityKey(projectId, linkScopeSortKey(source, linkId))
    )
    if (rows && rows.size > 1)
      throw new MaterializationConflictError(
        "source-materialization",
        `Multiple active source links assert cardinality-one scope '${source.objectTypeId}.${linkId}'.`
      )
    return structuredClone(rows?.values().next().value ?? null)
  }

  findActiveObjectSource(
    projectId: string,
    ref: OntologyObjectRef
  ): StoredSourceObjectAssertion | null {
    const found = this.findActiveSource(projectId, projectionEntityKey({ kind: "object", ref }))
    return found?.assertion.kind === "object" ? (found as StoredSourceObjectAssertion) : null
  }

  findActiveLinkSource(projectId: string, ref: OntologyLinkRef): StoredSourceLinkAssertion | null {
    const found = this.findActiveSource(projectId, projectionEntityKey({ kind: "link", ref }))
    return found?.assertion.kind === "link" ? (found as StoredSourceLinkAssertion) : null
  }

  findActiveSource(projectId: string, entityKey: string): StoredSourceAssertion | null {
    const rows = this.state.activeSourceRows.get(projectEntityKey(projectId, entityKey))
    if (rows && rows.size > 1)
      throw new MaterializationConflictError(
        "source-materialization",
        `Multiple active sources assert ${entityKey}.`
      )
    return structuredClone(rows?.values().next().value ?? null)
  }

  incidentLinkIndex(projectId: string): Map<string, readonly OntologyLinkRef[]> {
    const mutable = new Map<string, Map<string, OntologyLinkRef>>()
    const consider = (ref: OntologyLinkRef): void => {
      const sortKey = linkRefSortKey(ref)
      for (const endpoint of [ref.source, ref.target]) {
        const key = objectRefKey(endpoint)
        const links = mutable.get(key) ?? new Map<string, OntologyLinkRef>()
        links.set(sortKey, structuredClone(ref))
        mutable.set(key, links)
      }
    }
    getInMemoryObjectMaterializerAdapter(this.objects).visitExactLinks(projectId, (row) =>
      consider(linkRef(row))
    )
    for (const override of this.state.linkOverrides.values()) {
      if (override.projectId === projectId) consider(override.ref)
    }
    for (const override of this.state.linkSlotOverrides.values()) {
      if (override.projectId !== projectId) continue
      consider({
        source: override.ref.source,
        linkId: override.ref.linkId,
        target: override.value.target,
      })
    }
    for (const [scopeKey, rows] of this.state.activeSourceLinkScopes) {
      if (JSON.parse(scopeKey)[0] !== projectId) continue
      for (const row of rows.values()) {
        if (row.assertion.kind === "link") consider(row.assertion.ref)
      }
    }
    const index = new Map<string, readonly OntologyLinkRef[]>()
    for (const [objectKey, refs] of mutable) {
      index.set(
        objectKey,
        [...refs.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, ref]) => ref)
      )
    }
    return index
  }
}
