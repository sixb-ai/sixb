import { projectionEntityKey } from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  type InMemoryTimeseriesStorage,
} from "../../timeseries/store"
import type {
  ListObjectEditsInput,
  OntologyTypeShapeStorage,
  StoredObjectEdit,
  StoredTypeShape,
  TypeShapeProbeInput,
} from "../type-shapes"
import { type InMemoryOntologyState, projectEntityKey } from "./shared-state"

/**
 * Stored shapes live in the ontology state, so a transaction snapshot covers them. Probes scan
 * the maps: the in-memory store holds little, and its reads are the reference the SQL ones match.
 */
export class InMemoryOntologyTypeShapeStorage implements OntologyTypeShapeStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly timeseries: InMemoryTimeseriesStorage,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  /** In-memory transactions already run one at a time. */
  async lock(_input: { readonly projectId: string }): Promise<void> {}

  async list(input: { readonly projectId: string }): Promise<readonly StoredTypeShape[]> {
    return this.runRootOperation(() =>
      [...this.state.typeShapes.values()]
        .filter((row) => row.projectId === input.projectId)
        .map(({ projectId: _projectId, ...row }) => structuredClone(row))
        .sort((left, right) => compare(left.objectTypeId, right.objectTypeId))
    )
  }

  async write(input: StoredTypeShape & { readonly projectId: string }): Promise<void> {
    await this.runRootOperation(() => {
      this.state.typeShapes.set(
        shapeKey(input.projectId, input.objectTypeId),
        structuredClone(input)
      )
    })
  }

  async remove(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<void> {
    await this.runRootOperation(() => {
      this.state.typeShapes.delete(shapeKey(input.projectId, input.objectTypeId))
    })
  }

  async holds(input: TypeShapeProbeInput): Promise<boolean> {
    return (await this.count(input)) > 0
  }

  async count(input: TypeShapeProbeInput): Promise<number> {
    return this.runRootOperation(() => this.holders(input).size)
  }

  async listHeldKeys(input: {
    readonly projectId: string
    readonly objectTypeId: string
  }): Promise<{
    readonly linkIds: readonly string[]
    readonly seriesPropertyIds: readonly string[]
  }> {
    return this.runRootOperation(() => {
      const { projectId, objectTypeId } = input
      const linkIds = new Set<string>()
      this.visitLinkData(projectId, objectTypeId, undefined, (_primaryId, linkId) => {
        linkIds.add(linkId)
      })

      const seriesPropertyIds = new Set<string>()
      getInMemoryTimeseriesMaterializerAdapter(this.timeseries).visitSeries(
        projectId,
        (seriesTypeId, _objectId, propertyId) => {
          if (seriesTypeId === objectTypeId) seriesPropertyIds.add(propertyId)
        }
      )

      return {
        linkIds: [...linkIds].sort(compare),
        seriesPropertyIds: [...seriesPropertyIds].sort(compare),
      }
    })
  }

  async listEdits(input: ListObjectEditsInput): Promise<{
    readonly edits: readonly StoredObjectEdit[]
    readonly nextPrimaryId?: string
  }> {
    return this.runRootOperation(() => {
      const edits: StoredObjectEdit[] = []
      for (const row of this.state.objectOverrides.values()) {
        if (row.projectId !== input.projectId || row.ref.objectTypeId !== input.objectTypeId)
          continue
        if (row.value.kind === "delete") continue
        if (input.afterPrimaryId !== undefined && row.ref.primaryId <= input.afterPrimaryId)
          continue

        const values = row.value.kind === "create" ? row.value.properties : row.value.set
        if (input.withValueOf !== undefined && !Object.hasOwn(values, input.withValueOf)) continue

        edits.push({
          primaryId: row.ref.primaryId,
          value: structuredClone(row.value),
          editedAt: { ...(row.editedAt ?? {}) },
        })
      }

      edits.sort((left, right) => compare(left.primaryId, right.primaryId))
      const page = edits.slice(0, input.limit)
      if (edits.length <= input.limit) return { edits: page }

      return { edits: page, nextPrimaryId: page.at(-1)!.primaryId }
    })
  }

  /** The primary ids of the objects the probe finds, in every store it reads. */
  private holders(input: TypeShapeProbeInput): Set<string> {
    const { projectId, objectTypeId, probe } = input
    const found = new Set<string>()
    const add = (primaryId: string) => {
      found.add(primaryId)
    }

    if (probe.kind === "missingRequired") {
      for (const row of this.state.objectOverrides.values()) {
        if (row.projectId !== projectId || row.ref.objectTypeId !== objectTypeId) continue

        const value = row.value
        // Created by an edit with no source row and lacking the key, or cleared by an edit.
        const lacks =
          value.kind === "create" &&
          !Object.hasOwn(value.properties, probe.propertyId) &&
          !this.hasSourceRow(projectId, objectTypeId, row.ref.primaryId)
        const cleared = value.kind === "patch" && value.unset.includes(probe.propertyId)
        if (lacks || cleared) add(row.ref.primaryId)
      }
      return found
    }

    if (probe.kind === "link") {
      this.visitLinkData(projectId, objectTypeId, probe.linkId, add)
      return found
    }

    // A `type` probe matches every key.
    const propertyId = probe.kind === "property" ? probe.propertyId : undefined
    const holds = (values: Readonly<Record<string, unknown>> | readonly string[]) =>
      propertyId === undefined ||
      (Array.isArray(values) ? values.includes(propertyId) : Object.hasOwn(values, propertyId))

    getInMemoryObjectMaterializerAdapter(this.objects).visitExactObjects(
      projectId,
      objectTypeId,
      (row) => {
        if (holds(row.properties)) add(row.primaryId)
      }
    )

    for (const row of this.state.objectOverrides.values()) {
      if (row.projectId !== projectId || row.ref.objectTypeId !== objectTypeId) continue

      const value = row.value
      const held =
        propertyId === undefined ||
        holds(row.editedAt ?? {}) ||
        (value.kind === "create" && holds(value.properties)) ||
        (value.kind === "patch" && (holds(value.set) || holds(value.unset)))
      if (held) add(row.ref.primaryId)
    }

    for (const [key, sources] of this.state.activeSourceRows) {
      if (!isProjectKey(key, projectId)) continue

      for (const { assertion } of sources.values()) {
        if (assertion.kind !== "object" || assertion.ref.objectTypeId !== objectTypeId) continue
        if (holds(assertion.properties) || holds(assertion.absentSourcePropertyIds ?? [])) {
          add(assertion.ref.primaryId)
        }
      }
    }

    getInMemoryTimeseriesMaterializerAdapter(this.timeseries).visitSeries(
      projectId,
      (seriesTypeId, objectId, seriesPropertyId) => {
        if (seriesTypeId !== objectTypeId) return
        if (propertyId === undefined || seriesPropertyId === propertyId) add(objectId)
      }
    )

    if (probe.kind === "type") this.visitLinkData(projectId, objectTypeId, undefined, add)
    return found
  }

  /** Links, link edits and source link rows whose source is of the type, of `linkId` when given. */
  private visitLinkData(
    projectId: string,
    objectTypeId: string,
    linkId: string | undefined,
    visit: (sourcePrimaryId: string, linkId: string) => void
  ): void {
    const matches = (sourceTypeId: string, candidateLinkId: string) =>
      sourceTypeId === objectTypeId && (linkId === undefined || candidateLinkId === linkId)

    getInMemoryObjectMaterializerAdapter(this.objects).visitExactLinks(projectId, (row) => {
      if (matches(row.sourceTypeId, row.linkId)) visit(row.sourceId, row.linkId)
    })

    for (const row of [
      ...this.state.linkOverrides.values(),
      ...this.state.linkSlotOverrides.values(),
    ]) {
      if (row.projectId !== projectId) continue
      if (matches(row.ref.source.objectTypeId, row.ref.linkId)) {
        visit(row.ref.source.primaryId, row.ref.linkId)
      }
    }

    for (const [key, sources] of this.state.activeSourceRows) {
      if (!isProjectKey(key, projectId)) continue

      for (const { assertion } of sources.values()) {
        if (assertion.kind !== "link") continue
        if (matches(assertion.ref.source.objectTypeId, assertion.ref.linkId)) {
          visit(assertion.ref.source.primaryId, assertion.ref.linkId)
        }
      }
    }
  }

  private hasSourceRow(projectId: string, objectTypeId: string, primaryId: string): boolean {
    const key = projectionEntityKey({ kind: "object", ref: { objectTypeId, primaryId } })
    return (this.state.activeSourceRows.get(projectEntityKey(projectId, key))?.size ?? 0) > 0
  }
}

function shapeKey(projectId: string, objectTypeId: string): string {
  return JSON.stringify([projectId, objectTypeId])
}

function isProjectKey(key: string, projectId: string): boolean {
  return (JSON.parse(key) as [string, string])[0] === projectId
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
