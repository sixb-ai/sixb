import type { JsonValue } from "../../../json"
import type {
  ObjectOverride,
  OntologyObjectRef,
  ProjectionSourceAssertion,
} from "../../../materialization/model"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import {
  type ApplyOntologyMigrationBatchInput,
  addMigrationCounts,
  type CompiledMigrationSteps,
  compileMigrationSteps,
  migrationBatchConflict,
  migrationLanes,
  migrationRunAlreadyOpen,
  migrationRunType,
  movedVectorFingerprint,
  moveKeyList,
  moveKeys,
  type OntologyMigrationCounts,
  type OntologyMigrationLane,
  type OntologyMigrationLaneCursor,
  type OntologyMigrationLaneRecord,
  type OntologyMigrationRunRecord,
  type OntologyMigrationRunType,
  type OntologyMigrationStorage,
  rangeBoundaries,
  type SettledMigration,
  type StartOntologyMigrationRunInput,
} from "../migrations"
import type { InMemoryOntologyState } from "./shared-state"
import type { InMemorySnapshots } from "./snapshots"
import { typeShapeKey } from "./type-shapes"

interface LaneOutcome {
  readonly counts: Partial<OntologyMigrationCounts>
  /** Where the lane's next batch starts, or `null` once it is done. */
  readonly cursor: OntologyMigrationLaneCursor | null
}

/**
 * The in-memory reference of a run: each batch is checked first, then written in one go. It
 * splits a type's objects into two ranges, so the lanes and their resume run as on PostgreSQL; a
 * type's source rows and derived rows go in one batch each, since the store holds little.
 */
export class InMemoryOntologyMigrationStorage implements OntologyMigrationStorage {
  readonly parallelism = 2

  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly snapshots: InMemorySnapshots,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  async getOpenRun(input: { readonly projectId: string }) {
    return this.runRootOperation(() => {
      const open = [...this.state.migrationRuns.values()].find(
        (run) => run.projectId === input.projectId && run.status === "applying"
      )
      return open ? structuredClone(open) : null
    })
  }

  async listSettled(input: { readonly projectId: string }): Promise<readonly SettledMigration[]> {
    return this.runRootOperation(() =>
      [...this.state.settledMigrations.keys()]
        .flatMap((key) => {
          const [projectId, objectTypeId, migrationId] = JSON.parse(key) as [string, string, string]
          return projectId === input.projectId ? [{ objectTypeId, migrationId }] : []
        })
        .sort(
          (left, right) =>
            compare(left.objectTypeId, right.objectTypeId) ||
            compare(left.migrationId, right.migrationId)
        )
    )
  }

  async settle(input: {
    readonly projectId: string
    readonly migrations: readonly SettledMigration[]
    readonly settledAt: string
  }): Promise<void> {
    await this.runRootOperation(() => {
      for (const { objectTypeId, migrationId } of input.migrations) {
        const key = JSON.stringify([input.projectId, objectTypeId, migrationId])
        if (!this.state.settledMigrations.has(key)) {
          this.state.settledMigrations.set(key, input.settledAt)
        }
      }
    })
  }

  async startRun(input: StartOntologyMigrationRunInput): Promise<OntologyMigrationRunRecord> {
    return this.runRootOperation(() => {
      const { projectId } = input
      const open = [...this.state.migrationRuns.values()].find(
        (candidate) => candidate.projectId === projectId && candidate.status === "applying"
      )
      if (open) throw migrationRunAlreadyOpen(open.id)

      const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
      const boundaries = new Map<string, string[]>()
      for (const { objectTypeId } of input.plan.types) {
        const ids: string[] = []
        adapter.visitExactObjects(projectId, objectTypeId, (row) => ids.push(row.primaryId))
        boundaries.set(objectTypeId, rangeBoundaries(ids.sort(compare), input.parts))
      }

      const { parts: _parts, ...started } = input
      const run: OntologyMigrationRunRecord = {
        ...started,
        status: "applying",
        lanes: migrationLanes(input.plan, { objects: boundaries, sources: new Map() }),
      }
      this.state.migrationRuns.set(runKey(projectId, run.id), structuredClone(run))

      for (const type of run.plan.types) {
        const key = typeShapeKey(projectId, type.objectTypeId)
        const stored = this.state.typeShapes.get(key)
        this.state.typeShapes.set(key, {
          projectId,
          objectTypeId: type.objectTypeId,
          shape: stored?.shape ?? structuredClone(type.fromShape),
          // Past the point of no return, the release before can't serve the data.
          previous: null,
          updatedAt: stored?.updatedAt ?? run.startedAt,
          state: "migrating",
        })
      }

      for (const [key, plan] of this.state.replacementPlans) {
        if (plan.projectId === projectId) this.state.replacementPlans.delete(key)
      }
      return structuredClone(run)
    })
  }

  async applyBatch(input: ApplyOntologyMigrationBatchInput): Promise<OntologyMigrationLaneRecord> {
    return this.runRootOperation(() => {
      const run = this.state.migrationRuns.get(runKey(input.projectId, input.runId))
      const lane = run?.lanes[input.ordinal]
      if (!run || !lane || run.status !== "applying" || lane.batches !== input.batches) {
        throw migrationBatchConflict(input.runId)
      }
      if (!lane.cursor) throw migrationBatchConflict(input.runId)

      const outcome = this.applyLane(run, lane.lane, lane.cursor, input)
      const next: OntologyMigrationLaneRecord = {
        ...lane,
        cursor: outcome.cursor,
        batches: lane.batches + 1,
        counts: addMigrationCounts(lane.counts, outcome.counts),
      }

      const lanes = run.lanes.map((candidate) => (candidate === lane ? next : candidate))
      this.state.migrationRuns.set(runKey(run.projectId, run.id), { ...run, lanes })
      return structuredClone(next)
    })
  }

  async finishRun(input: {
    readonly projectId: string
    readonly runId: string
    readonly appliedAt: string
  }): Promise<OntologyMigrationRunRecord> {
    return this.runRootOperation(() => {
      const run = this.state.migrationRuns.get(runKey(input.projectId, input.runId))
      if (!run || run.status !== "applying" || run.lanes.some((lane) => lane.cursor !== null)) {
        throw migrationBatchConflict(input.runId)
      }

      for (const type of run.plan.types) {
        this.state.typeShapes.set(typeShapeKey(run.projectId, type.objectTypeId), {
          projectId: run.projectId,
          objectTypeId: type.objectTypeId,
          shape: structuredClone(type.toShape),
          previous: null,
          updatedAt: input.appliedAt,
          state: "current",
        })
        for (const step of type.steps) {
          const key = JSON.stringify([run.projectId, type.objectTypeId, step.migrationId])
          if (!this.state.settledMigrations.has(key)) {
            this.state.settledMigrations.set(key, input.appliedAt)
          }
        }
      }

      const applied: OntologyMigrationRunRecord = {
        ...run,
        status: "applied",
        appliedAt: input.appliedAt,
      }
      this.state.migrationRuns.set(runKey(run.projectId, run.id), applied)
      return structuredClone(applied)
    })
  }

  private applyLane(
    run: OntologyMigrationRunRecord,
    lane: OntologyMigrationLane,
    cursor: OntologyMigrationLaneCursor,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    switch (cursor.kind) {
      case "objects":
        return this.applyObjects(run, lane, cursor, input)
      case "derived":
        return { counts: this.applyDerived(run, lane.objectTypeId), cursor: null }
      case "sources":
        return { counts: this.applySources(run, lane.objectTypeId), cursor: null }
    }
  }

  /**
   * One batch of the lane's range: up to `batchRows` objects and edits after the cursor, ending
   * at the lower of the two last keys, or at the range's end on its last batch.
   */
  private applyObjects(
    run: OntologyMigrationRunRecord,
    lane: OntologyMigrationLane,
    cursor: Extract<OntologyMigrationLaneCursor, { kind: "objects" }>,
    input: ApplyOntologyMigrationBatchInput
  ): LaneOutcome {
    const laneEnd = "through" in lane ? lane.through : undefined
    const { projectId } = run
    const { objectTypeId } = lane
    const type = migrationRunType(run.plan, objectTypeId)
    const compiled = compileMigrationSteps(type)
    const { keys } = compiled
    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    const inLane = (primaryId: string) =>
      (cursor.afterPrimaryId === undefined || primaryId > cursor.afterPrimaryId) &&
      (laneEnd === undefined || primaryId <= laneEnd)

    const objects: Parameters<Parameters<typeof adapter.visitExactObjects>[2]>[0][] = []
    adapter.visitExactObjects(projectId, objectTypeId, (row) => {
      if (inLane(row.primaryId)) objects.push(row)
    })
    const overrides = [...this.state.objectOverrides.entries()].filter(
      ([, row]) =>
        row.projectId === projectId &&
        row.ref.objectTypeId === objectTypeId &&
        inLane(row.ref.primaryId)
    )
    objects.sort((left, right) => compare(left.primaryId, right.primaryId))
    overrides.sort(([, left], [, right]) => compare(left.ref.primaryId, right.ref.primaryId))

    const through = lowest(
      objects[input.batchRows - 1]?.primaryId,
      overrides[input.batchRows - 1]?.[1].ref.primaryId
    )
    const inBatch = (primaryId: string) =>
      inLane(primaryId) && (through === undefined || primaryId <= through)
    const commitId = input.commit.id
    let changed = false
    let rewrittenObjects = 0
    let rewrittenEdits = 0

    // Before the objects: a moved vector is checked against the values it was built from.
    const vectors = this.applyVectors(run, type, compiled, inBatch)

    for (const row of objects) {
      if (!inBatch(row.primaryId) || !holdsAny(row.properties, keys)) continue

      const ref = { objectTypeId, primaryId: row.primaryId }
      adapter.applyExactObject(
        {
          ref,
          properties: moveKeys(row.properties as Record<string, JsonValue>, compiled),
          version: row.version + 1,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          lastCommitId: commitId,
        },
        projectId
      )
      changed = true
      rewrittenObjects += 1
    }

    for (const [key, row] of overrides) {
      if (!inBatch(row.ref.primaryId)) continue

      const value = movedOverride(row.value, compiled)
      const editedAt = row.editedAt ?? {}
      if (value === row.value && !holdsAny(editedAt, keys)) continue

      // Edit times move with their values: lineage still finds the edit that set it.
      this.state.objectOverrides.set(key, {
        ...row,
        value,
        editedAt: moveKeys(editedAt, compiled),
        lastCommitId: commitId,
      })
      changed = true
      rewrittenEdits += 1
    }

    const links = this.deleteLinks(projectId, objectTypeId, compiled.removedLinkIds, inBatch)
    if (changed) this.snapshots.commit(input.commit)

    return {
      counts: { objects: rewrittenObjects, edits: rewrittenEdits, links, vectors },
      cursor: through === undefined ? null : { kind: "objects", afterPrimaryId: through },
    }
  }

  /**
   * The batch's vectors whose source held a key: one of a moved profile takes its new source,
   * configuration and fingerprint, and keeps its embedding; every other one goes.
   */
  private applyVectors(
    run: OntologyMigrationRunRecord,
    type: OntologyMigrationRunType,
    compiled: CompiledMigrationSteps,
    inBatch: (primaryId: string) => boolean
  ): number {
    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    let rewritten = 0

    for (const [key, vectors] of this.state.vectors) {
      const [projectId, objectTypeId, primaryId] = JSON.parse(key) as [string, string, string]
      if (projectId !== run.projectId || objectTypeId !== type.objectTypeId) continue
      if (!inBatch(primaryId)) continue

      const properties = adapter.getExactObjectRow(projectId, objectTypeId, primaryId)?.properties
      for (const [profile, vector] of vectors) {
        if (!vector.source.some((source) => compiled.keys.includes(source))) continue
        rewritten += 1

        const move = type.vectors?.find(
          (candidate) =>
            candidate.profile === profile && candidate.fromConfiguration === vector.configuration
        )
        const fingerprint =
          move && properties
            ? movedVectorFingerprint(move, vector.sourceFingerprint, properties)
            : null
        if (!move || fingerprint === null) {
          vectors.delete(profile)
          continue
        }

        vectors.set(profile, {
          ...vector,
          source: [...move.toSource],
          configuration: move.toConfiguration,
          sourceFingerprint: fingerprint,
        })
      }
      if (vectors.size === 0) this.state.vectors.delete(key)
    }

    return rewritten + this.moveIndexingWork(run, type, inBatch)
  }

  /**
   * The batch's queued indexing of a moved profile, asked for under the old keys: it takes the
   * profile's new configuration and the fingerprint of the same values under the new keys, or
   * goes when its object no longer holds the values it was asked for.
   */
  private moveIndexingWork(
    run: OntologyMigrationRunRecord,
    type: OntologyMigrationRunType,
    inBatch: (primaryId: string) => boolean
  ): number {
    const moves = type.vectors ?? []
    if (moves.length === 0) return 0

    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    let rewritten = 0

    for (const [key, work] of this.state.vectorIndexing) {
      if (work.projectId !== run.projectId || work.ref.objectTypeId !== type.objectTypeId) continue
      if (!inBatch(work.ref.primaryId)) continue

      const move = moves.find(
        (candidate) =>
          candidate.profile === work.profile && candidate.fromConfiguration === work.configuration
      )
      if (!move) continue

      const properties = adapter.getExactObjectRow(
        run.projectId,
        work.ref.objectTypeId,
        work.ref.primaryId
      )?.properties
      const fingerprint =
        properties && movedVectorFingerprint(move, work.sourceFingerprint, properties)
      rewritten += 1

      if (!fingerprint) {
        this.state.vectorIndexing.delete(key)
        continue
      }
      this.state.vectorIndexing.set(key, {
        ...work,
        configuration: move.toConfiguration,
        sourceFingerprint: fingerprint,
      })
    }

    return rewritten
  }

  /** The batch's links of a removed link, and their edits: edges, and slots of every kind. */
  private deleteLinks(
    projectId: string,
    objectTypeId: string,
    linkIds: readonly string[],
    inBatch: (primaryId: string) => boolean
  ): number {
    if (linkIds.length === 0) return 0

    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    const removed = (source: OntologyObjectRef, linkId: string) =>
      source.objectTypeId === objectTypeId && linkIds.includes(linkId) && inBatch(source.primaryId)

    const links: Parameters<Parameters<typeof adapter.visitExactLinks>[1]>[0][] = []
    adapter.visitExactLinks(projectId, (row) => {
      const source = { objectTypeId: row.sourceTypeId, primaryId: row.sourceId }
      if (removed(source, row.linkId)) links.push(row)
    })
    for (const row of links) adapter.deleteExactLink(row)

    let edits = 0
    for (const overrides of [this.state.linkOverrides, this.state.linkSlotOverrides]) {
      for (const [key, row] of overrides) {
        if (row.projectId !== projectId || !removed(row.ref.source, row.ref.linkId)) continue
        overrides.delete(key)
        edits += 1
      }
    }

    return links.length + edits
  }

  /** Unique values and artifact refs, by property, and the source rows of removed links. */
  private applyDerived(
    run: OntologyMigrationRunRecord,
    objectTypeId: string
  ): Partial<OntologyMigrationCounts> {
    const compiled = compileMigrationSteps(migrationRunType(run.plan, objectTypeId))
    const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
    let uniqueValues = 0
    let artifactRefs = 0

    for (const { from, to } of derivedMoves(compiled)) {
      const uniqueTo = compiled.uniqueMoves.some((move) => move.from === from) ? to : null
      uniqueValues += adapter.moveUniqueProperty(run.projectId, objectTypeId, from, uniqueTo)
      artifactRefs += adapter.moveArtifactHolders(run.projectId, objectTypeId, from, to)
    }

    const sources = this.deleteSourceLinks(run.projectId, objectTypeId, compiled.removedLinkIds)
    return { uniqueValues, artifactRefs, sources }
  }

  /** Every version's rows of a removed link whose source is of the type, active ones included. */
  private deleteSourceLinks(
    projectId: string,
    objectTypeId: string,
    linkIds: readonly string[]
  ): number {
    if (linkIds.length === 0) return 0

    const removed = (assertion: ProjectionSourceAssertion) =>
      assertion.kind === "link" &&
      assertion.ref.source.objectTypeId === objectTypeId &&
      linkIds.includes(assertion.ref.linkId)
    let deleted = 0

    for (const [key, materialization] of this.state.sourceMaterializations) {
      if (materialization.projectId !== projectId) continue

      let fromVersion = 0
      for (const [entityKey, row] of materialization.rowsByEntity) {
        if (!removed(row.assertion)) continue
        materialization.rowsByEntity.delete(entityKey)
        for (const root of materialization.roots.values()) root.entityKeys.delete(entityKey)
        fromVersion += 1
      }

      // As pg and SQLite do: the version's count is its rows'.
      if (fromVersion > 0 && materialization.assertionCount !== null) {
        this.state.sourceMaterializations.set(key, {
          ...materialization,
          assertionCount: materialization.assertionCount - fromVersion,
        })
      }
      deleted += fromVersion
    }

    for (const index of [this.state.activeSourceRows, this.state.activeSourceLinkScopes]) {
      for (const [key, rows] of index) {
        if ((JSON.parse(key) as [string, string])[0] !== projectId) continue

        for (const [rowKey, row] of rows) {
          if (removed(row.assertion)) rows.delete(rowKey)
        }
        if (rows.size === 0) index.delete(key)
      }
    }

    return deleted
  }

  /** Every version's rows, the active index's included: assertions are shared, so replaced. */
  private applySources(
    run: OntologyMigrationRunRecord,
    objectTypeId: string
  ): Partial<OntologyMigrationCounts> {
    const compiled = compileMigrationSteps(migrationRunType(run.plan, objectTypeId))
    const { keys } = compiled
    const rewrite = (assertion: ProjectionSourceAssertion): ProjectionSourceAssertion | null => {
      if (assertion.kind !== "object" || assertion.ref.objectTypeId !== objectTypeId) return null
      const absent = assertion.absentSourcePropertyIds ?? []
      if (!holdsAny(assertion.properties, keys) && !absent.some((id) => keys.includes(id))) {
        return null
      }

      const { absentSourcePropertyIds: _absent, ...rest } = assertion
      const kept = moveKeyList(absent, compiled)
      return {
        ...rest,
        properties: moveKeys(assertion.properties, compiled),
        ...(kept.length > 0 ? { absentSourcePropertyIds: kept } : {}),
      }
    }

    let sources = 0
    for (const materialization of this.state.sourceMaterializations.values()) {
      if (materialization.projectId !== run.projectId) continue

      for (const [entityKey, row] of materialization.rowsByEntity) {
        const assertion = rewrite(row.assertion)
        if (!assertion) continue
        materialization.rowsByEntity.set(entityKey, { ...row, assertion })
        sources += 1
      }
    }

    for (const [indexKey, rows] of this.state.activeSourceRows) {
      if ((JSON.parse(indexKey) as [string, string])[0] !== run.projectId) continue

      for (const [projectionId, row] of rows) {
        const assertion = rewrite(row.assertion)
        if (assertion) rows.set(projectionId, { ...row, assertion } as typeof row)
      }
    }

    return { sources }
  }
}

/** The override with the compiled keys dropped and renamed, or itself when it holds none. */
function movedOverride(value: ObjectOverride, compiled: CompiledMigrationSteps): ObjectOverride {
  const { keys } = compiled

  switch (value.kind) {
    case "create":
      if (!holdsAny(value.properties, keys)) return value
      return { ...value, properties: moveKeys(value.properties, compiled) }
    case "patch":
      if (!holdsAny(value.set, keys) && !value.unset.some((id) => keys.includes(id))) return value
      return {
        ...value,
        set: moveKeys(value.set, compiled),
        unset: moveKeyList(value.unset, compiled),
      }
    case "delete":
      return value
  }
}

/** Each removed property and renamed `from`, with where its derived rows go: `null` drops them. */
function derivedMoves(
  compiled: CompiledMigrationSteps
): { readonly from: string; readonly to: string | null }[] {
  return [...compiled.removedPropertyIds.map((from) => ({ from, to: null })), ...compiled.renames]
}

function holdsAny(values: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(values, key))
}

function lowest(...keys: readonly (string | undefined)[]): string | undefined {
  const defined = keys.filter((key) => key !== undefined)
  return defined.length === 0 ? undefined : defined.sort(compare)[0]
}

function runKey(projectId: string, runId: string): string {
  return JSON.stringify([projectId, runId])
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
