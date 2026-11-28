import type { JsonValue } from "../../../json"
import type { ObjectOverride } from "../../../materialization/model"
import { objectRefKey } from "../../../materialization/refs"
import {
  getInMemoryObjectMaterializerAdapter,
  type InMemoryObjectStorage,
} from "../../objects/in-memory"
import type {
  CompiledMigrationSteps,
  ListMigrationValueTargetsInput,
  MigrationHeldUniqueProperty,
  MigrationUniqueCollision,
  OntologyMigrationCounts,
  OntologyMigrationValueStorage,
  StagedObjectValues,
} from "../migrations"
import { type InMemoryOntologyState, projectEntityKey } from "./shared-state"

type Adapter = ReturnType<typeof getInMemoryObjectMaterializerAdapter>

/**
 * What value steps add to the in-memory run: the staging is a map per run and type, read in
 * primary-id order like the tables of the SQL providers.
 */
export class InMemoryOntologyMigrationValueStorage implements OntologyMigrationValueStorage {
  constructor(
    private readonly state: InMemoryOntologyState,
    private readonly objects: InMemoryObjectStorage,
    private readonly runRootOperation: <T>(run: () => Promise<T> | T) => Promise<T>
  ) {}

  /** The ids of the walk under way, sorted once when it starts, by what it lists. */
  private walk: { readonly key: string; readonly primaryIds: readonly string[] } | null = null

  /**
   * A page of a walk the first page starts: the type's edits are scanned and sorted once per walk,
   * not once per page. A walk sees the ids as they were when it started; writes are paused.
   */
  async listValueTargets(input: ListMigrationValueTargetsInput) {
    return this.runRootOperation(() => {
      const { afterPrimaryId, limit, ...filter } = input
      const key = JSON.stringify(filter)
      if (afterPrimaryId === undefined || this.walk?.key !== key) {
        this.walk = { key, primaryIds: this.targets(input) }
      }

      const ids = this.walk.primaryIds
      let start = 0
      if (afterPrimaryId !== undefined) {
        let high = ids.length
        while (start < high) {
          const middle = (start + high) >>> 1
          if (ids[middle]! <= afterPrimaryId) start = middle + 1
          else high = middle
        }
      }

      const primaryIds = ids.slice(start, start + limit)
      return primaryIds.length === limit
        ? { primaryIds, nextPrimaryId: primaryIds.at(-1)! }
        : { primaryIds }
    })
  }

  private targets(input: ListMigrationValueTargetsInput): string[] {
    const { projectId, objectTypeId } = input
    const ids = new Set<string>()

    for (const row of this.state.objectOverrides.values()) {
      if (row.projectId !== projectId || row.ref.objectTypeId !== objectTypeId) continue

      const { value } = row
      const values =
        value.kind === "create" ? value.properties : value.kind === "patch" ? value.set : {}
      const holds = input.holding.some((propertyId) => Object.hasOwn(values, propertyId))
      const clears = value.kind === "patch" && input.clearing.some((id) => value.unset.includes(id))
      if (holds || clears || (input.creates && value.kind === "create")) ids.add(row.ref.primaryId)
    }
    if (input.everyObject) {
      const adapter = getInMemoryObjectMaterializerAdapter(this.objects)
      adapter.visitExactObjects(projectId, objectTypeId, (row) => ids.add(row.primaryId))
    }

    return [...ids].sort(compare)
  }

  async stageValues(input: {
    readonly projectId: string
    readonly runId: string
    readonly rows: readonly StagedObjectValues[]
  }): Promise<void> {
    await this.runRootOperation(() => {
      for (const row of input.rows) {
        const key = stagedTypeKey(input.projectId, input.runId, row.objectTypeId)
        const staged = this.state.stagedMigrationValues.get(key) ?? new Map()
        staged.set(row.primaryId, structuredClone(row))
        this.state.stagedMigrationValues.set(key, staged)
      }
    })
  }

  async findUniqueCollisions(input: {
    readonly projectId: string
    readonly runId: string
    readonly held: readonly MigrationHeldUniqueProperty[]
    readonly limit: number
  }) {
    return this.runRootOperation(() =>
      findUniqueCollisions(this.state, getInMemoryObjectMaterializerAdapter(this.objects), input)
    )
  }

  async discardStaged(input: { readonly projectId: string; readonly runId: string }) {
    await this.runRootOperation(() =>
      discardStaged(this.state, input.projectId, (runId) => runId !== input.runId)
    )
  }
}

function stagedTypeKey(projectId: string, runId: string, objectTypeId: string): string {
  return JSON.stringify([projectId, runId, objectTypeId])
}

/** The run's staged rows of a type whose primary id `inBatch` takes, in primary-id order. */
export function stagedRows(
  state: InMemoryOntologyState,
  projectId: string,
  runId: string,
  objectTypeId: string,
  inBatch: (primaryId: string) => boolean
): StagedObjectValues[] {
  const staged = state.stagedMigrationValues.get(stagedTypeKey(projectId, runId, objectTypeId))
  return [...(staged?.values() ?? [])]
    .filter((row) => inBatch(row.primaryId))
    .sort((left, right) => compare(left.primaryId, right.primaryId))
}

/** Drops the project's staging of every run `keep` doesn't keep. */
export function discardStaged(
  state: InMemoryOntologyState,
  projectId: string,
  keep: (runId: string) => boolean
): void {
  for (const key of state.stagedMigrationValues.keys()) {
    const [stagedProject, runId] = JSON.parse(key) as [string, string, string]
    if (stagedProject === projectId && !keep(runId)) state.stagedMigrationValues.delete(key)
  }
}

function findUniqueCollisions(
  state: InMemoryOntologyState,
  adapter: Adapter,
  input: {
    readonly projectId: string
    readonly runId: string
    readonly held: readonly MigrationHeldUniqueProperty[]
    readonly limit: number
  }
): MigrationUniqueCollision[] {
  const { projectId, runId } = input
  const claims = new Map<string, MigrationUniqueCollision & { primaryIds: string[] }>()
  const releasing = new Set<string>()

  const rows = [...state.stagedMigrationValues.entries()]
    .filter(([key]) => {
      const [stagedProject, stagedRun] = JSON.parse(key) as [string, string, string]
      return stagedProject === projectId && stagedRun === runId
    })
    .flatMap(([, staged]) => [...staged.values()])
    .sort((left, right) => compare(left.primaryId, right.primaryId))
  for (const row of rows) {
    for (const [propertyId, keys] of Object.entries(row.unique)) {
      releasing.add(JSON.stringify([row.objectTypeId, propertyId, row.primaryId]))
      if (keys.to === null) continue

      const key = JSON.stringify([row.objectTypeId, propertyId, keys.to])
      const claim = claims.get(key) ?? {
        objectTypeId: row.objectTypeId,
        propertyId,
        valueKey: keys.to,
        primaryIds: [],
      }
      claim.primaryIds.push(row.primaryId)
      claims.set(key, claim)
    }
  }

  const twice = [...claims.values()].filter((claim) => claim.primaryIds.length > 1)
  const kept = [...claims.values()].flatMap((claim) => {
    const held = input.held.find(
      (property) =>
        property.objectTypeId === claim.objectTypeId && property.propertyId === claim.propertyId
    )
    if (!held) return []

    // Until the run, the values are under the id the objects store them by.
    const holder = adapter.getUniqueHolder(projectId, {
      ...claim,
      propertyId: held.storedPropertyId,
    })
    const released = releasing.has(JSON.stringify([claim.objectTypeId, claim.propertyId, holder]))
    if (holder === null || claim.primaryIds.includes(holder) || released) return []

    return [{ ...claim, holder }]
  })

  return [...twice, ...kept].slice(0, input.limit)
}

/**
 * The batch's staged values, after its key steps: each edit takes its new values in place, each
 * object its new effective values, at one version more unless the key steps already bumped it in
 * this batch, and each vector whose source changed is queued for indexing.
 */
export function applyStagedObjects(
  state: InMemoryOntologyState,
  adapter: Adapter,
  input: {
    readonly projectId: string
    readonly rows: readonly StagedObjectValues[]
    readonly commitId: string
    readonly committedAt: string
  }
): Partial<OntologyMigrationCounts> & { readonly changed: boolean } {
  const { projectId, commitId } = input
  let objects = 0
  let edits = 0
  let vectors = 0

  for (const row of input.rows) {
    const ref = { objectTypeId: row.objectTypeId, primaryId: row.primaryId }
    const key = projectEntityKey(projectId, objectRefKey(ref))
    const override = state.objectOverrides.get(key)

    if (override && Object.keys(row.edits).length > 0) {
      if (override.lastCommitId !== commitId) edits += 1
      state.objectOverrides.set(key, {
        ...override,
        value: withEdits(override.value, row.edits, row.restored),
        editedAt: { ...override.editedAt, ...row.editedAt },
        lastCommitId: commitId,
      })
    }

    const object = adapter.getExactObjectRow(projectId, ref.objectTypeId, ref.primaryId)
    if (object && Object.keys(row.effective).length > 0) {
      const bumped = object.lastCommitId === commitId
      if (!bumped) objects += 1
      adapter.applyExactObject(
        {
          ref,
          properties: { ...(object.properties as Record<string, JsonValue>), ...row.effective },
          version: bumped ? object.version : object.version + 1,
          createdAt: object.createdAt.toISOString(),
          updatedAt: object.updatedAt.toISOString(),
          lastCommitId: commitId,
        },
        projectId
      )
    }

    for (const vector of object ? row.vectors : []) {
      vectors += 1
      state.vectorIndexing.set(
        JSON.stringify([projectId, ref.objectTypeId, ref.primaryId, vector.profile]),
        {
          ...vector,
          ref,
          sourceCommitId: commitId,
          projectId,
          status: "pending",
          availableAt: input.committedAt,
          dispatchAt: input.committedAt,
        }
      )
    }
  }

  return { objects, edits, vectors, changed: objects + edits > 0 }
}

/**
 * The unique values value steps change, for the properties prepared the way the code compares
 * them: every staged object's old key goes before any new one is claimed, so two objects may swap.
 */
export function applyStagedUnique(
  adapter: Adapter,
  projectId: string,
  compiled: CompiledMigrationSteps,
  rows: readonly StagedObjectValues[]
): number {
  const updates = rows.flatMap((row) =>
    Object.entries(row.unique)
      .filter(([propertyId]) => compiled.uniqueUpdates.includes(propertyId))
      .map(([propertyId, keys]) => ({ row, propertyId, keys }))
  )
  for (const { row, propertyId, keys } of updates) {
    if (keys.from === null) continue
    const { objectTypeId, primaryId } = row
    adapter.releaseUniqueValue(projectId, {
      objectTypeId,
      propertyId,
      valueKey: keys.from,
      primaryId,
    })
  }
  for (const { row, propertyId, keys } of updates) {
    if (keys.to === null) continue
    const entries = [{ valueKey: keys.to, primaryId: row.primaryId }]
    adapter.insertUniqueValues(projectId, row.objectTypeId, propertyId, entries)
  }

  return updates.length
}

function withEdits(
  value: ObjectOverride,
  edits: Readonly<Record<string, JsonValue>>,
  restored: readonly string[]
): ObjectOverride {
  switch (value.kind) {
    case "create":
      return { ...value, properties: { ...value.properties, ...edits } }
    case "patch":
      return {
        ...value,
        set: { ...value.set, ...edits },
        unset: value.unset.filter((id) => !restored.includes(id)),
      }
    case "delete":
      return value
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
