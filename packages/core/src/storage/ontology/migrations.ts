/**
 * Applying ontology migrations: a run's record, its lanes and their batches, and the migrations a
 * database has settled. `packages/core/src/migrations/README.md` describes the flow.
 */

import type { JsonValue } from "../../json"
import { vectorSources } from "../../objects/vectors/profile"
import type { TypeShape } from "../../ontology/type-shapes"
import type { OntologyCommitRecord } from "./commits"
import type { VectorIndexingRequest } from "./vector-indexing"

/** One step as storage applies it, on every store that holds its key. */
export type OntologyMigrationStoreStep =
  | { readonly kind: "removeProperty"; readonly propertyId: string }
  | {
      readonly kind: "renameProperty"
      readonly from: string
      readonly to: string
      /**
       * `move`: `from`'s unique values become `to`'s, as they were prepared the way `to`'s
       * compare. `drop`: they go, and if `to` is unique its values are built after the run, once
       * a dry run under `from` found no duplicate. Either way, what `to` held goes first, its
       * preparation included.
       */
      readonly unique: "move" | "drop"
    }
  | { readonly kind: "removeLink"; readonly linkId: string }
  | {
      /** Its values were computed and staged before the run started: the run applies them. */
      readonly kind: "fillProperty" | "convertProperty"
      readonly propertyId: string
      /**
       * For a unique property, how its values follow. `update`: the derived lane releases each
       * staged object's old key and claims its new one. `rebuild`: they are built again after the
       * run, as for a newly unique property, since their keys change kind.
       */
      readonly unique?: "update" | "rebuild"
    }

/**
 * A vector profile whose source names a renamed property: its stored vectors keep their
 * embedding, under the source and configuration the code gives the profile.
 */
export interface OntologyMigrationVectorMove {
  readonly profile: string
  /** The profile's configuration with the old keys, which the stored vectors were built with. */
  readonly fromConfiguration: string
  readonly toConfiguration: string
  readonly fromSource: readonly string[]
  readonly toSource: readonly string[]
}

export interface OntologyMigrationRunType {
  readonly objectTypeId: string
  /** What the type's stored objects fit when the run started. */
  readonly fromShape: TypeShape
  /** What they fit once it is applied: the code's shape, recorded when the run finishes. */
  readonly toShape: TypeShape
  /** In the order they apply. */
  readonly steps: readonly (OntologyMigrationStoreStep & { readonly migrationId: string })[]
  /** The vector profiles the type's renames move, if any. */
  readonly vectors?: readonly OntologyMigrationVectorMove[]
}

/** What a run applies, fixed when it starts: a resume never reads the code again. */
export interface OntologyMigrationRunPlan {
  /** The ontology revision every batch commit carries. */
  readonly ontologyRevision: string
  readonly migrations: readonly { readonly id: string; readonly hash: string }[]
  readonly types: readonly OntologyMigrationRunType[]
}

/**
 * One independent stream of batches, fixed when the run starts. Lanes touch disjoint rows, so a
 * provider may apply them side by side:
 *
 * - `objects`: one primary-id range of a type, `after` excluded and `through` included, either
 *   open when absent: its objects, edits, links and link edits, and the vectors of those objects.
 * - `sources`: one root-key range of a type's source roots, every version's, bounded the same way:
 *   the rows of those roots.
 * - `derived`: a type's unique values, artifact refs and source rows of removed links.
 */
export type OntologyMigrationLane =
  | {
      readonly kind: "objects" | "sources"
      readonly objectTypeId: string
      readonly after?: string
      readonly through?: string
    }
  | { readonly kind: "derived"; readonly objectTypeId: string }

/** Where a lane's next batch starts, by the kind of the lane. */
export type OntologyMigrationLaneCursor =
  | { readonly kind: "objects"; readonly afterPrimaryId?: string }
  | { readonly kind: "sources"; readonly versionId?: string; readonly afterRootKey?: string }
  | {
      readonly kind: "derived"
      /**
       * Unique values, then those value steps give, then artifact refs, then the source rows of
       * removed links.
       */
      readonly store: "uniqueValues" | "stagedUnique" | "artifactRefs" | "sourceLinks"
      /** The provider's key of the last row deleted, in its own terms. */
      readonly after?: readonly string[]
    }

/** Rows each store rewrote or deleted. */
export interface OntologyMigrationCounts {
  readonly objects: number
  readonly edits: number
  /** Links and link edits deleted. */
  readonly links: number
  readonly vectors: number
  readonly uniqueValues: number
  readonly artifactRefs: number
  readonly sources: number
}

export interface OntologyMigrationLaneRecord {
  /** The lane's place in the run, which names its batch commits. */
  readonly ordinal: number
  readonly lane: OntologyMigrationLane
  /** The next batch, or `null` once the lane is done. */
  readonly cursor: OntologyMigrationLaneCursor | null
  readonly batches: number
  readonly counts: OntologyMigrationCounts
}

export interface OntologyMigrationRunRecord {
  readonly projectId: string
  readonly id: string
  /** The kernel execution `ontology.migrate` every batch commit belongs to. */
  readonly executionId: string
  readonly status: "applying" | "applied"
  /** Every batch commit's time. */
  readonly startedAt: string
  readonly appliedAt?: string
  readonly plan: OntologyMigrationRunPlan
  readonly lanes: readonly OntologyMigrationLaneRecord[]
}

/** A migration this database ran, or recorded a type's shape past while it wasn't pending. */
export interface SettledMigration {
  readonly objectTypeId: string
  readonly migrationId: string
}

export interface StartOntologyMigrationRunInput {
  readonly projectId: string
  readonly id: string
  readonly executionId: string
  readonly startedAt: string
  readonly plan: OntologyMigrationRunPlan
  /** Ranges per type and lane kind: the provider splits a large type into at most this many. */
  readonly parts: number
}

export interface ApplyOntologyMigrationBatchInput {
  readonly projectId: string
  readonly runId: string
  readonly ordinal: number
  /** The lane's `batches` as the caller read it: another applier moved it, and this fails. */
  readonly batches: number
  /** Written when the batch rewrites an object or an edit. It lists no touches. */
  readonly commit: OntologyCommitRecord
  /** Objects and edits, or source roots, one batch covers at most. */
  readonly batchRows: number
}

/**
 * What a run's value steps give one object, computed before it starts. The staging is the only
 * copy of what the steps' functions returned: a resume applies it, and never calls them again.
 * Every record is keyed by property id, as the code declares it.
 */
export interface StagedObjectValues {
  readonly objectTypeId: string
  readonly primaryId: string
  /** Edit values set in place: in `create.properties` or `patch.set`, whichever the edit is. */
  readonly edits: Readonly<Record<string, JsonValue>>
  /** Edit times set with them: a fill's is the run's start; a convert keeps the edit's own. */
  readonly editedAt: Readonly<Record<string, string>>
  /** Ids a fill gives a value a `patch` had cleared: they leave its `unset`. */
  readonly restored: readonly string[]
  /** The effective values that change. */
  readonly effective: Readonly<Record<string, JsonValue>>
  /** Per unique property, the key the object holds before the run, and after it. */
  readonly unique: Readonly<Record<string, StagedUniqueKeys>>
  /** The vector indexing the new values call for, queued by the batch that applies them. */
  readonly vectors: readonly StagedVectorRequest[]
}

export interface StagedUniqueKeys {
  readonly from: string | null
  readonly to: string | null
}

export type StagedVectorRequest = Pick<
  VectorIndexingRequest,
  "id" | "profile" | "configuration" | "sourceFingerprint"
>

export interface ListMigrationValueTargetsInput {
  readonly projectId: string
  readonly objectTypeId: string
  /** Every `create` edit. */
  readonly creates: boolean
  /** Every edit that gives one of these a value, in `create.properties` or `patch.set`. */
  readonly holding: readonly string[]
  /** Every patch whose `unset` clears one of these: a fill refuses the object, explaining why. */
  readonly clearing: readonly string[]
  /** Every object as well, edited or not. */
  readonly everyObject: boolean
  readonly afterPrimaryId?: string
  readonly limit: number
}

/** A unique property whose values outside a run's staging stay as they are. */
export interface MigrationHeldUniqueProperty {
  readonly objectTypeId: string
  readonly propertyId: string
  /** The id its values are stored under until the run: a moving rename's `from`, or itself. */
  readonly storedPropertyId: string
}

/** A unique key two staged objects take, or that `holder`, outside the staging, keeps. */
export interface MigrationUniqueCollision {
  readonly objectTypeId: string
  readonly propertyId: string
  readonly valueKey: string
  /** The staged objects that take it, by primary id. */
  readonly primaryIds: readonly string[]
  readonly holder?: string
}

/** The staging of a run's value steps, written before it starts and read by its batches. */
export interface OntologyMigrationValueStorage {
  /**
   * A keyset page of the primary ids a type's value steps read, losing edits included. Deletes
   * hold no values: no id is listed for one.
   */
  listValueTargets(input: ListMigrationValueTargetsInput): Promise<{
    readonly primaryIds: readonly string[]
    readonly nextPrimaryId?: string
  }>

  /** Adds rows to the staging of a run about to start: `runId` is the id `startRun` takes. */
  stageValues(input: {
    readonly projectId: string
    readonly runId: string
    readonly rows: readonly StagedObjectValues[]
  }): Promise<void>

  /**
   * Up to `limit` unique keys the staging gives two objects, then those an object outside it
   * holds for one of `held`: the properties whose other values stay as they are, looked up under
   * the id they are stored by until the run.
   */
  findUniqueCollisions(input: {
    readonly projectId: string
    readonly runId: string
    readonly held: readonly MigrationHeldUniqueProperty[]
    readonly limit: number
  }): Promise<readonly MigrationUniqueCollision[]>

  /** Drops what a run staged that won't start: a plan that failed. */
  discardStaged(input: { readonly projectId: string; readonly runId: string }): Promise<void>
}

export interface OntologyMigrationStorage {
  /**
   * How many lanes the provider applies side by side, and the ranges it splits a large type's
   * objects and source roots into; 1 applies every lane one after another.
   */
  readonly parallelism: number

  getOpenRun(input: { readonly projectId: string }): Promise<OntologyMigrationRunRecord | null>

  listSettled(input: { readonly projectId: string }): Promise<readonly SettledMigration[]>

  /** Records migrations as settled; one already settled stays as it was. */
  settle(input: {
    readonly projectId: string
    readonly migrations: readonly SettledMigration[]
    readonly settledAt: string
  }): Promise<void>

  /**
   * The staging value steps need, on a provider that applies them. Without it, a deploy refuses a
   * pending fill or convert data needs, as it refuses every migration on a provider without
   * `migrations`.
   */
  readonly values?: OntologyMigrationValueStorage

  /**
   * The point of no return, in the caller's transaction: records the run `applying` with its
   * lanes, marks each planned type's stored shape `migrating` (writing `fromShape` where none is
   * stored yet), and drops the project's replacement plans, which may hold the old keys, and what
   * other runs staged, which never started. Refuses while a run is open.
   *
   * Batches write no commit touches. Only replacement plans read them, and none can be open: this
   * drops them all, writes are paused (the deploy stops the live release, roles refuse a
   * `migrating` shape, `sixb dev` starts its workers after migrating), so no projection run opens
   * one before `finishRun`.
   */
  startRun(input: StartOntologyMigrationRunInput): Promise<OntologyMigrationRunRecord>

  /**
   * Applies the lane's next batch in one transaction: only rows that hold a key the steps remove
   * or rename, a link they remove, or values the run staged, set-based, each rewritten object at
   * `version + 1` once; the commit when an object or an edit changed, and no outbox row; the
   * lane's cursor, batches and counts saved last.
   */
  applyBatch(input: ApplyOntologyMigrationBatchInput): Promise<OntologyMigrationLaneRecord>

  /**
   * Once every lane is done, in one transaction: each planned type's shape becomes its
   * `toShape`, `current`; the run is `applied`; its migrations are settled for the types they ran
   * on. The provider may then refresh its statistics of the rewritten tables, and drop the run's
   * staging.
   */
  finishRun(input: {
    readonly projectId: string
    readonly runId: string
    readonly appliedAt: string
  }): Promise<OntologyMigrationRunRecord>
}

export const EMPTY_MIGRATION_COUNTS: OntologyMigrationCounts = {
  objects: 0,
  edits: 0,
  links: 0,
  vectors: 0,
  uniqueValues: 0,
  artifactRefs: 0,
  sources: 0,
}

/** Each type's range boundaries, sorted, each the last key of its range. */
export interface MigrationLaneBoundaries {
  readonly objects: ReadonlyMap<string, readonly string[]>
  readonly sources: ReadonlyMap<string, readonly string[]>
}

/**
 * The lanes of a plan: per type, one sources lane per root-key range and one objects lane per
 * primary-id range between `boundaries`, interleaved so that both progress side by side, then its
 * derived rows.
 */
export function migrationLanes(
  plan: OntologyMigrationRunPlan,
  boundaries: MigrationLaneBoundaries
): OntologyMigrationLaneRecord[] {
  const lanes: OntologyMigrationLane[] = []

  for (const { objectTypeId } of plan.types) {
    const objects = ranges("objects", objectTypeId, boundaries.objects.get(objectTypeId))
    const sources = ranges("sources", objectTypeId, boundaries.sources.get(objectTypeId))
    for (let index = 0; index < Math.max(objects.length, sources.length); index += 1) {
      lanes.push(...[sources[index], objects[index]].filter((lane) => lane !== undefined))
    }
    lanes.push({ kind: "derived", objectTypeId })
  }

  return lanes.map((lane, ordinal) => ({
    ordinal,
    lane,
    cursor: firstCursor(lane),
    batches: 0,
    counts: EMPTY_MIGRATION_COUNTS,
  }))
}

function ranges(
  kind: "objects" | "sources",
  objectTypeId: string,
  boundaries: readonly string[] = []
): OntologyMigrationLane[] {
  const lanes: OntologyMigrationLane[] = []
  let after: string | undefined

  for (const through of [...boundaries, undefined]) {
    lanes.push({
      kind,
      objectTypeId,
      ...(after === undefined ? {} : { after }),
      ...(through === undefined ? {} : { through }),
    })
    after = through
  }
  return lanes
}

function firstCursor(lane: OntologyMigrationLane): OntologyMigrationLaneCursor {
  switch (lane.kind) {
    case "objects":
      return {
        kind: "objects",
        ...(lane.after === undefined ? {} : { afterPrimaryId: lane.after }),
      }
    case "sources":
      return { kind: "sources", ...(lane.after === undefined ? {} : { afterRootKey: lane.after }) }
    case "derived":
      return { kind: "derived", store: "uniqueValues" }
  }
}

/** Up to `parts - 1` boundaries splitting `sorted` primary ids evenly; none for a small type. */
export function rangeBoundaries(sorted: readonly string[], parts: number): string[] {
  if (parts <= 1 || sorted.length < parts * 2) return []

  const boundaries: string[] = []
  for (let part = 1; part < parts; part += 1) {
    const boundary = sorted[Math.floor((sorted.length * part) / parts) - 1]!
    if (boundary !== boundaries.at(-1)) boundaries.push(boundary)
  }
  return boundaries
}

/** What a type's steps do, compiled into what each store drops and moves in one statement. */
export interface CompiledMigrationSteps {
  /** Every key a row is rewritten for: the removed ones and each rename's `from`. */
  readonly keys: readonly string[]
  readonly removedPropertyIds: readonly string[]
  /** Disjoint from the removed ids: a `from` is undeclared, a `to` declared. */
  readonly renames: readonly { readonly from: string; readonly to: string }[]
  /** Renames whose unique values move, by `from`. */
  readonly uniqueMoves: readonly { readonly from: string; readonly to: string }[]
  readonly removedLinkIds: readonly string[]
  /** The properties value steps give values to: the batches apply what the run staged for them. */
  readonly valuePropertyIds: readonly string[]
  /** Those whose unique values the derived lane updates from the staged keys. */
  readonly uniqueUpdates: readonly string[]
}

/** One expression per store, never one statement per step. */
export function compileMigrationSteps(type: OntologyMigrationRunType): CompiledMigrationSteps {
  const removedPropertyIds: string[] = []
  const renames: { readonly from: string; readonly to: string }[] = []
  const uniqueMoves: { readonly from: string; readonly to: string }[] = []
  const removedLinkIds: string[] = []
  const valuePropertyIds = new Set<string>()
  const uniqueUpdates = new Set<string>()

  for (const step of type.steps) {
    switch (step.kind) {
      case "removeProperty":
        removedPropertyIds.push(step.propertyId)
        break
      case "renameProperty":
        renames.push({ from: step.from, to: step.to })
        if (step.unique === "move") uniqueMoves.push({ from: step.from, to: step.to })
        break
      case "removeLink":
        removedLinkIds.push(step.linkId)
        break
      case "fillProperty":
      case "convertProperty":
        valuePropertyIds.add(step.propertyId)
        if (step.unique === "update") uniqueUpdates.add(step.propertyId)
        break
      default:
        unknownStep(step)
    }
  }

  const keys = [...removedPropertyIds, ...renames.map((rename) => rename.from)]
  return {
    keys,
    removedPropertyIds,
    renames,
    uniqueMoves,
    removedLinkIds,
    valuePropertyIds: [...valuePropertyIds],
    uniqueUpdates: [...uniqueUpdates],
  }
}

/** `values` with the compiled keys dropped and each renamed value under its `to`. */
export function moveKeys<T>(
  values: Readonly<Record<string, T>>,
  compiled: CompiledMigrationSteps
): Record<string, T> {
  const moved: Record<string, T> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!compiled.keys.includes(key)) moved[key] = value
  }
  for (const { from, to } of compiled.renames) {
    if (Object.hasOwn(values, from)) moved[to] = values[from]!
  }
  return moved
}

/** A list of property ids with the compiled keys dropped and renamed ones replaced. */
export function moveKeyList(ids: readonly string[], compiled: CompiledMigrationSteps): string[] {
  return ids.flatMap((id) => {
    const rename = compiled.renames.find((candidate) => candidate.from === id)
    if (rename) return [rename.to]
    return compiled.keys.includes(id) ? [] : [id]
  })
}

/**
 * The fingerprint a stored vector of a moved profile takes, from its object's properties as
 * stored before the batch, or `null` when the vector no longer matches them and goes.
 */
export function movedVectorFingerprint(
  move: OntologyMigrationVectorMove,
  sourceFingerprint: string,
  properties: Readonly<Record<string, unknown>>
): string | null {
  if (vectorSources(move.fromSource, properties).sourceFingerprint !== sourceFingerprint) {
    return null
  }

  const values = Object.fromEntries(
    move.toSource.map((id, index) => [id, properties[move.fromSource[index]!]])
  )
  return vectorSources(move.toSource, values).sourceFingerprint
}

/** Where the derived lane goes once the removed and renamed keys' unique values are done. */
export function afterUniqueValues(compiled: CompiledMigrationSteps): OntologyMigrationLaneCursor {
  const store = compiled.uniqueUpdates.length > 0 ? "stagedUnique" : "artifactRefs"
  return { kind: "derived", store }
}

/** The planned type a lane applies to. */
export function migrationRunType(
  plan: OntologyMigrationRunPlan,
  objectTypeId: string
): OntologyMigrationRunType {
  const type = plan.types.find((candidate) => candidate.objectTypeId === objectTypeId)
  if (!type) throw new Error(`[Sixb] The migration run plans no type '${objectTypeId}'.`)
  return type
}

/**
 * Every source root key of a type's objects sorts from this prefix to {@link rootKeyEnd},
 * excluded, byte by byte: a key is `["object","<type>","<primary id>"]`.
 */
export function rootKeyPrefix(objectTypeId: string): string {
  return `${JSON.stringify(["object", objectTypeId]).slice(0, -1)},`
}

export function rootKeyEnd(objectTypeId: string): string {
  return `${rootKeyPrefix(objectTypeId).slice(0, -1)}-`
}

export function addMigrationCounts(
  counts: OntologyMigrationCounts,
  batch: Partial<OntologyMigrationCounts>
): OntologyMigrationCounts {
  return {
    objects: counts.objects + (batch.objects ?? 0),
    edits: counts.edits + (batch.edits ?? 0),
    links: counts.links + (batch.links ?? 0),
    vectors: counts.vectors + (batch.vectors ?? 0),
    uniqueValues: counts.uniqueValues + (batch.uniqueValues ?? 0),
    artifactRefs: counts.artifactRefs + (batch.artifactRefs ?? 0),
    sources: counts.sources + (batch.sources ?? 0),
  }
}

/** Every lane's batches and counts, summed. */
export function migrationRunTotals(run: OntologyMigrationRunRecord): {
  readonly batches: number
  readonly counts: OntologyMigrationCounts
} {
  return {
    batches: run.lanes.reduce((sum, lane) => sum + lane.batches, 0),
    counts: run.lanes.reduce(
      (sum, lane) => addMigrationCounts(sum, lane.counts),
      EMPTY_MIGRATION_COUNTS
    ),
  }
}

/** The lane another process moved, or that isn't open: nothing of this batch was written. */
export function migrationBatchConflict(runId: string): Error {
  return new Error(
    `[Sixb] Migration run '${runId}' moved on while this batch ran: another process applies it. ` +
      "Let it finish, then run the command again."
  )
}

export function migrationRunAlreadyOpen(runId: string): Error {
  return new Error(
    `[Sixb] Migration run '${runId}' is being applied: finish it with \`sixb db migrate\` first.`
  )
}

function unknownStep(step: never): never {
  throw new Error(`[Sixb] This build can't apply a '${(step as { kind: string }).kind}' step.`)
}
