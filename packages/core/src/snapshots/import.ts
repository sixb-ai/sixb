import { randomUUID } from "node:crypto"
import { ensureExecutionRecord, executionRecordInputFromRuntime } from "../execution/durable"
import { createKernelScope } from "../execution/scopes"
import type { JsonValue } from "../json"
import { sha256Canonical } from "../materialization/identity"
import { projectionEntityKey } from "../materialization/refs"
import { ValuePlanError } from "../migrations/plan-values"
import type { MigrationDefinition } from "../migrations/types"
import { vectorConfiguration } from "../objects/vectors/profile"
import type { OntologyRegistry } from "../ontology"
import { collectArtifactRefIds } from "../ontology/artifact-ref"
import type { ObjectType, Property } from "../ontology/types"
import { UNIQUE_VALUE_KEY_VERSION, uniqueValueKey } from "../ontology/unique-values"
import type { UserRef } from "../ontology/user-ref"
import type { ProjectionDefinitionCatalog } from "../projections"
import { computeProjectionOwnership } from "../projections/ownership"
import { computeOntologyRevision } from "../projections/revision"
import { applyTypeShapes } from "../storage/migrations/migrate-storage"
import {
  finding,
  formatTypeShapeFindings,
  heldFinding,
  type NarrowedChange,
  narrows,
  type ProbedChange,
  uncheckedLine,
} from "../storage/migrations/type-shape-messages"
import {
  checkTypeShapes,
  type TypeShapeCheck,
  type TypeShapeTypeCheck,
} from "../storage/migrations/type-shapes"
import {
  type OntologyCommitRecord,
  SNAPSHOT_COMMIT_ID_PREFIX,
  type SnapshotWithheldProperties,
} from "../storage/ontology/commits"
import type {
  ExactArtifactHolderWrite,
  ExactUniqueValueClaim,
} from "../storage/ontology/materializations"
import type { OntologyMigrationRunRecord } from "../storage/ontology/migrations"
import type { PreparedUniqueProperty } from "../storage/ontology/unique-values"
import {
  isSnapshotLoadStorage,
  type SnapshotLinkWrite,
  type SnapshotLoader,
  type SnapshotLoadStorage,
  type SnapshotObjectWrite,
  type SnapshotSourceWrite,
} from "../storage/snapshots"
import type { Storage } from "../storage/types"
import { checkTypeFits, type TypeFit } from "./definitions"
import {
  decodeSnapshot,
  fromColumns,
  type SnapshotEdits,
  type SnapshotEnd,
  type SnapshotLinks,
  type SnapshotManifest,
  type SnapshotMembers,
  type SnapshotObjects,
  type SnapshotPoints,
  type SnapshotRecord,
  type SnapshotSkipKind,
  type SnapshotSourceRoots,
  type SnapshotTypeManifest,
  type SnapshotTypeShape,
  type SnapshotVectors,
} from "./format"

export interface ImportSnapshotInput {
  /**
   * The snapshot's bytes, from a file or straight from {@link exportSnapshot}. A function reads
   * them again when the copy must load anew without the types the branch's gate refused; bytes
   * that can't be read again fail the import in that case.
   */
  readonly snapshot: AsyncIterable<Uint8Array> | (() => AsyncIterable<Uint8Array>)
  /** The branch's storage: a namespace that holds no object yet. */
  readonly storage: Storage
  /** The branch's definitions: each type is checked against them, and imported if it fits. */
  readonly ontology: OntologyRegistry
  /**
   * The branch's projections. A type whose source travels is loaded as that source when the
   * branch's projection of the same id still feeds it; otherwise as created objects.
   */
  readonly projections?: ProjectionDefinitionCatalog
  /**
   * The branch's migrations. Once the copy is loaded with production's shapes, the branch's gate
   * runs on it as a deploy would, and applies those still pending: the branch is the dry run.
   */
  readonly migrations?: readonly MigrationDefinition[]
}

/** A type left out of the copy. */
export interface SnapshotSkip {
  readonly objectTypeId: string
  readonly kind: SnapshotSkipKind
  /** Why, in a sentence. */
  readonly reason: string
  /** The lines a deploy of the branch's code prints for it, with the data's counts. */
  readonly findings: readonly string[]
}

export interface SnapshotImportReport {
  readonly projectId: string
  readonly takenAt: string
  readonly takenBy: UserRef
  /** The base commit every imported row belongs to. */
  readonly commitId: string
  readonly members: "all" | "self"
  readonly users: number
  readonly types: readonly ImportedSnapshotType[]
  /**
   * Types left out, and why: unreadable in production, or no longer fitting the branch, with the
   * lines a deploy would print and the migration that would resolve them.
   */
  readonly skipped: readonly SnapshotSkip[]
}

export interface ImportedSnapshotType {
  readonly objectTypeId: string
  readonly objects: number
  readonly links: number
  readonly points: number
  readonly vectors: number
  /**
   * Properties the person cannot read: no object holds a value for them, so the branch's
   * migrations never ran on them.
   */
  readonly hiddenPropertyIds: readonly string[]
  /** Whether a view condition hides some of the type's objects from the person. */
  readonly throughCondition: boolean
  /**
   * The hidden properties the branch requires. The objects and their links read normally; any
   * write to one, a new link included, fails while the property is unset, and says why.
   */
  readonly requiredHiddenPropertyIds: readonly string[]
  /** Properties the branch no longer defines, left out. */
  readonly droppedPropertyIds: readonly string[]
  /** Links left out because the branch removed or redefined them, or skipped their target. */
  readonly droppedLinks: number
  /** Vector profiles left out, and why. */
  readonly skippedVectors: readonly { readonly profile: string; readonly reason: string }[]
  /** The branch's migrations applied to the copy's objects of the type. */
  readonly migrationIds: readonly string[]
  /**
   * What a deploy of the branch's code would refuse in what the copy held: properties and links
   * it removed with no migration, which the copy leaves out. The lines a deploy prints, counted.
   */
  readonly refusedByDeploy: readonly string[]
  /**
   * What a deploy would read that the copy can't, one line each: changes of properties hidden
   * from the person, or of keys production's code no longer declares, whose values don't travel,
   * and value changes of properties a projection feeds on a type copied as created objects.
   */
  readonly unchecked: readonly string[]
  /** Set for a type a projection feeds in production. */
  readonly projectionId?: string
  /**
   * Whether the branch's projection continues from production's source, so a new version of its
   * dataset on the branch updates the objects. Set with `projectionId`.
   */
  readonly reprojectable?: boolean
  /** Why it cannot, when it cannot: the type was loaded as created objects. */
  readonly notReprojectable?: string
}

/**
 * Load a snapshot into a branch's storage as one base commit: no event is emitted and no outbox
 * row is written, so nothing reacts to the import. Unique values and artifact references are
 * derived from the objects, as a write would, and the provider indexes after the load. Then the
 * branch's gate runs on the copy, from production's shapes, and applies its pending migrations.
 */
export async function importSnapshot(input: ImportSnapshotInput): Promise<SnapshotImportReport> {
  const storage = input.storage
  if (!isSnapshotLoadStorage(storage)) {
    throw new Error(
      "[Sixb] This storage provider cannot load a snapshot. Use PostgreSQL, SQLite or in-memory storage."
    )
  }

  const read = typeof input.snapshot === "function" ? input.snapshot : undefined
  let copy = await loadCopy(
    input,
    storage,
    read ? read() : (input.snapshot as AsyncIterable<Uint8Array>)
  )

  // The deploy decides from data: a type whose copied objects the branch's code doesn't fit, with
  // no migration that makes them fit, is refused, and so is one whose value steps refuse objects.
  // The copy is emptied and loaded again without it, so that nothing on the branch holds data its
  // code can't serve. A refusal is final, so this ends: each round leaves out one type more.
  let refused = refusedTypes(copy)
  for (;;) {
    if (refused.length > 0) copy = await loadAgain(input, storage, copy, read, refused)

    try {
      const migration = await applyTypeShapes(
        storage,
        {
          projectId: copy.manifest.projectId,
          ontology: input.ontology,
          migrations: input.migrations ?? [],
          ...(input.projections ? { projections: input.projections } : {}),
        },
        copy.check
      )
      return report(copy, migration)
    } catch (error) {
      // The plan of fills and converts runs before the point of no return: nothing was written.
      if (!(error instanceof ValuePlanError)) throw error

      const left = new Set(refused.map((skip) => skip.objectTypeId))
      const more = planRefusals(error).filter((skip) => !left.has(skip.objectTypeId))
      if (more.length === 0) throw error
      refused = [...refused, ...more]
    }
  }
}

/**
 * Empty the copy and load it again without the types refused so far. The copy read again must
 * be the same one, and the gate must refuse nothing more: anything else is a copy read wrongly.
 */
async function loadAgain(
  input: ImportSnapshotInput,
  storage: SnapshotLoadStorage,
  copy: LoadedCopy,
  read: (() => AsyncIterable<Uint8Array>) | undefined,
  refused: readonly SnapshotSkip[]
): Promise<LoadedCopy> {
  await storage.unloadSnapshot({ projectId: copy.manifest.projectId, commitId: copy.commit.id })
  if (!read) {
    throw new Error(
      `[Sixb] The branch's code doesn't fit the copy of ${refused.map((skip) => skip.objectTypeId).join(", ")}, and the copy can't be read again to load without it. Pass the snapshot as a function that reads it again.`
    )
  }

  const again = await loadCopy(input, storage, read(), refused)
  if (again.manifest.takenAt !== copy.manifest.takenAt || refusedTypes(again).length > 0) {
    throw new Error(
      "[Sixb] The copy read again is not the one loaded first, or still holds data the branch's code doesn't fit. Take a new copy."
    )
  }
  return again
}

/** The types whose objects a fill or a convert refuses, each with the lines a deploy prints. */
function planRefusals(error: ValuePlanError): SnapshotSkip[] {
  return [...error.byType()].map(([objectTypeId, lines]) => ({
    objectTypeId,
    kind: "unfit" as const,
    reason: "the branch's migrations can't give its objects values the code accepts",
    findings: [`✗ ${lines[0]}`, ...lines.slice(1)],
  }))
}

function report(
  copy: LoadedCopy,
  migration: OntologyMigrationRunRecord | null
): SnapshotImportReport {
  return {
    projectId: copy.manifest.projectId,
    takenAt: copy.manifest.takenAt,
    takenBy: copy.manifest.takenBy,
    commitId: copy.commit.id,
    members: copy.manifest.members,
    users: copy.users,
    types: copy.plan.report(migration, copy.check),
    skipped: copy.plan.skips(),
  }
}

interface LoadedCopy {
  readonly manifest: SnapshotManifest
  readonly plan: ImportPlan
  readonly commit: OntologyCommitRecord
  readonly users: number
  /** The branch's gate on the loaded copy, in `check` mode: what a deploy would decide. */
  readonly check: TypeShapeCheck
}

/**
 * One load of the copy: the types the shapes and `refused` allow, as one base commit, then
 * production's shapes, then the branch's gate on what was loaded, which writes nothing.
 */
async function loadCopy(
  input: ImportSnapshotInput,
  storage: SnapshotLoadStorage,
  snapshot: AsyncIterable<Uint8Array>,
  refused: readonly SnapshotSkip[] = []
): Promise<LoadedCopy> {
  const records = decodeSnapshot(snapshot)[Symbol.asyncIterator]()

  // A failed import closes the stream it reads, so an export feeding it ends its read too.
  try {
    const manifest = await expectRecord(records, "manifest")
    const members = await expectRecord(records, "members")

    const plan = new ImportPlan({
      manifest,
      ontology: input.ontology,
      projections: input.projections,
      migrations: input.migrations ?? [],
      appliesMigrations: storage.ontology.migrations !== undefined,
      refused,
    })
    const users = await importMembers(storage, manifest.projectId, members)
    const commit = await baseCommit(storage, manifest, members, plan, input.ontology)

    // The checks run before the provider commits: a stream they refuse leaves nothing behind.
    await storage.loadSnapshot(
      {
        projectId: manifest.projectId,
        commit,
        uniqueProperties: plan.uniqueProperties(),
        objectTypeIds: plan.objectTypeIds(),
      },
      async (loader) => {
        const sources = plan.sources()
        if (sources.length > 0) await loader.write({ sources })

        const end = await loadRecords(records, plan, loader, commit.id)
        assertComplete(end, plan, members.users.length)
      }
    )

    await recordProductionShapes(storage, manifest.projectId, plan)
    const check = await checkTypeShapes({
      storage,
      projectId: manifest.projectId,
      ontology: input.ontology,
      migrations: input.migrations ?? [],
      mode: "check",
      unseen: plan.unseenProperties(),
      unseenValues: plan.projectedProperties(),
      uniqueDuplicates: true,
    })

    return { manifest, plan, commit, users, check }
  } catch (error) {
    await records.return?.(undefined).catch(() => undefined)
    throw error
  }
}

/**
 * The loaded types the gate found the copy's data doesn't fit, with its lines: a change no
 * migration resolves, or two objects sharing a value of a property made unique. A property hidden
 * from the person says nothing of production's values: the copy holds none, so the gate leaves its
 * changes out (`unseen`), and the report lists them as not checked.
 */
function refusedTypes(copy: LoadedCopy): SnapshotSkip[] {
  return copy.check.types.flatMap((type) => {
    if (!copy.plan.type(type.objectTypeId)) return []

    const findings = type.findings
    if (findings.length === 0) return []

    return [
      {
        objectTypeId: type.objectTypeId,
        kind: "unfit" as const,
        reason: "production's objects don't fit the branch's code, and no migration makes them fit",
        findings: formatTypeShapeFindings(findings),
      },
    ]
  })
}

/**
 * The counts the snapshot's end records must match what it held: a stream that lost or repeated
 * a frame on its way is refused, and the load with it.
 */
function assertComplete(end: SnapshotEnd, plan: ImportPlan, users: number): void {
  const expected: SnapshotEnd["counts"] = end.counts
  const actual: SnapshotEnd["counts"] = { ...plan.read, users }

  for (const key of Object.keys(expected) as (keyof SnapshotEnd["counts"])[]) {
    if (expected[key] === actual[key]) continue
    throw new Error(
      `[Sixb] The snapshot cannot be read: it says it holds ${expected[key]} ${key}, and holds ${actual[key]}. Take it again.`
    )
  }
}

/**
 * What production's objects fit, recorded on the branch before its gate runs, with the migrations
 * production settled: the gate then compares them with the branch's code as a deploy would. A
 * type production never recorded, and a version 2 snapshot, have none: the gate reads the copy as
 * a first deploy does.
 */
async function recordProductionShapes(
  storage: SnapshotLoadStorage,
  projectId: string,
  plan: ImportPlan
): Promise<void> {
  const types = plan.recorded()
  if (types.length === 0) return

  const updatedAt = new Date().toISOString()
  const settled = types.flatMap(({ objectTypeId, shape }) =>
    shape.settledMigrationIds.map((migrationId) => ({ objectTypeId, migrationId }))
  )

  await storage.transaction(async (tx) => {
    await tx.ontology.typeShapes.lock({ projectId })

    // A branch has no release before it to start.
    for (const { objectTypeId, shape } of types) {
      await tx.ontology.typeShapes.write({
        projectId,
        objectTypeId,
        shape: shape.fits,
        previous: null,
        updatedAt,
      })
    }
    if (settled.length > 0) {
      await tx.ontology.migrations?.settle({ projectId, migrations: settled, settledAt: updatedAt })
    }
  })
}

async function expectRecord<K extends SnapshotRecord["kind"]>(
  records: AsyncIterator<SnapshotRecord>,
  kind: K
): Promise<Extract<SnapshotRecord, { kind: K }>> {
  const next = await records.next()
  if (next.done || next.value.kind !== kind) {
    throw new Error(`[Sixb] The snapshot cannot be read: its ${kind} is missing.`)
  }
  return next.value as Extract<SnapshotRecord, { kind: K }>
}

/**
 * The load's execution, the kernel operation `ontology.loadSnapshot`, and its commit, which lists
 * no change: its rows are what it holds. It records what the copy withheld, which a write on the
 * branch reads to say why it fails.
 */
async function baseCommit(
  storage: SnapshotLoadStorage,
  manifest: SnapshotManifest,
  members: SnapshotMembers,
  plan: ImportPlan,
  ontology: OntologyRegistry
): Promise<OntologyCommitRecord> {
  const id = `${SNAPSHOT_COMMIT_ID_PREFIX}${randomUUID()}`
  const scope = createKernelScope({
    projectId: manifest.projectId,
    operation: { type: "ontology.loadSnapshot", snapshotId: id },
    source: { type: "http", requestId: id },
    correlationId: id,
  })
  await ensureExecutionRecord(storage.executions, {
    ...executionRecordInputFromRuntime({
      execution: scope.execution,
      runtimeAuthorization: scope.authorization,
    }),
    requesterGroupIds: [],
  })

  const committedAt = new Date().toISOString()
  return {
    projectId: manifest.projectId,
    id,
    idempotencyKey: id,
    requestHash: sha256Canonical({ snapshot: manifest.takenAt, takenBy: manifest.takenBy }),
    executionId: scope.execution.id,
    origin: { kind: "runtime", requestId: id },
    ontologyRevision: computeOntologyRevision(ontology),
    committedAt,
    intent: {
      kind: "edit",
      mode: "atomic",
      operationCount: 0,
      ...withheldProperties(manifest, members, plan),
    },
    result: {
      kind: "edit",
      commitId: id,
      created: true,
      eventCount: 0,
      committedAt,
      outcomes: [],
      changes: { objects: [], links: [] },
    },
  }
}

/** The required properties the copy holds no value for, and whom they are hidden from. */
function withheldProperties(
  manifest: SnapshotManifest,
  members: SnapshotMembers,
  plan: ImportPlan
): { readonly withheld?: SnapshotWithheldProperties } {
  const properties = plan.requiredHiddenPropertyIds()
  if (Object.keys(properties).length === 0) return {}

  const creator = members.users.find(([userId]) => userId === manifest.takenBy.id)
  return { withheld: { takenBy: creator?.[1] ?? manifest.takenBy.id, properties } }
}

type LoadingFit = Extract<TypeFit, { fits: true }>

interface TypePlan {
  readonly manifest: SnapshotTypeManifest
  readonly objectType: ObjectType
  readonly fit: LoadingFit
  /**
   * The objects holding each removal the copy leaves out, by its key: a property's are counted,
   * a link's sources gathered, as the gate counts objects by primary id.
   */
  readonly heldProperties: Map<string, number>
  readonly heldLinks: Map<string, Set<string>>
  readonly droppedPropertyIds: Set<string>
  readonly droppedLinkIds: ReadonlySet<string>
  /** Hidden from the person, and required by the branch: no object holds them. */
  readonly requiredHiddenPropertyIds: readonly string[]
  readonly telemetryPropertyIds: ReadonlySet<string>
  readonly unique: readonly {
    readonly propertyId: string
    readonly kind: PreparedUniqueProperty["keyKind"]
  }[]
  readonly artifactRefs: readonly Property[]
  readonly counts: {
    objects: number
    links: number
    points: number
    vectors: number
    droppedLinks: number
  }
  readonly skippedVectors: Map<string, string>
  /** The source the type loads as, when it travelled as one and the branch can continue it. */
  readonly source?: SnapshotSourceWrite
  readonly notReprojectable?: string
  /**
   * The properties production's projection feeds, on a type loaded as created objects: their
   * values are edits on the copy, where a deploy would read most as the projection's.
   */
  readonly projectedPropertyIds: ReadonlySet<string>
  /** The next root's place among the source's roots. */
  nextOrdinal: number
}

/** What each type of the snapshot becomes on the branch. */
class ImportPlan {
  readonly #types = new Map<string, TypePlan>()
  readonly #ontology: OntologyRegistry
  readonly #skipped: SnapshotSkip[] = []
  /** Objects of each type the branch no longer defines: a deploy refuses to remove it if any. */
  readonly #skippedHeld = new Map<
    string,
    { readonly change: Extract<ProbedChange, { kind: "type-removed" | "primary" }>; count: number }
  >()
  /** What the snapshot held, skipped types included, to check against its end. */
  readonly read = { objects: 0, links: 0, points: 0, vectors: 0, sourceRoots: 0, edits: 0 }
  readonly #byProjection = new Map<string, TypePlan>()

  constructor(input: {
    readonly manifest: SnapshotManifest
    readonly ontology: OntologyRegistry
    readonly projections: ProjectionDefinitionCatalog | undefined
    readonly migrations: readonly MigrationDefinition[]
    readonly appliesMigrations: boolean
    /** The types the branch's gate refused on an earlier load of the same copy. */
    readonly refused: readonly SnapshotSkip[]
  }) {
    const { manifest, ontology, projections, migrations, appliesMigrations } = input
    this.#ontology = ontology

    for (const objectTypeId of manifest.unreadableTypeIds) {
      this.#skipped.push({
        objectTypeId,
        kind: "unreadable",
        reason: "the person who took it cannot read this type",
        findings: [],
      })
    }

    const refused = new Map(input.refused.map((skip) => [skip.objectTypeId, skip]))
    for (const type of manifest.types) {
      const skip = refused.get(type.objectTypeId)
      if (skip) {
        this.#skipped.push(skip)
        continue
      }

      const fit = checkTypeFits({ manifest: type, ontology, migrations, appliesMigrations })
      if (!fit.fits) {
        const { kind, reason, findings } = fit
        this.#skipped.push({ objectTypeId: type.objectTypeId, kind, reason, findings })
        const change = skippedChange(fit.kind, type, ontology)
        if (change) this.#skippedHeld.set(type.objectTypeId, { change, count: 0 })
        continue
      }

      const objectType = ontology.resolveObjectType(type.objectTypeId)
      const travel = sourceTravel(type, fit, projections)
      const typePlan: TypePlan = {
        manifest: type,
        objectType,
        fit,
        heldProperties: new Map(
          fit.leftOut.flatMap((change) =>
            change.kind === "property-removed" && !fit.withheld.includes(change.propertyId)
              ? [[change.propertyId, 0] as const]
              : []
          )
        ),
        heldLinks: new Map(
          fit.leftOut.flatMap((change) =>
            "linkId" in change ? [[change.linkId, new Set<string>()] as const] : []
          )
        ),
        droppedPropertyIds: new Set(fit.droppedPropertyIds),
        droppedLinkIds: new Set(fit.droppedLinkIds),
        requiredHiddenPropertyIds: objectType.properties
          .filter((p) => p.required && p.mode !== "telemetry")
          .map((p) => p.id)
          .filter((propertyId) => type.hiddenPropertyIds.includes(propertyId)),
        telemetryPropertyIds: new Set(
          objectType.properties.filter((p) => p.mode === "telemetry").map((p) => p.id)
        ),
        // A property production did not hold unique may hold one value twice: the branch's own
        // preparation backfills it, and refuses the duplicates as it would anywhere else.
        unique: ontology
          .listUniqueProperties(type.objectTypeId)
          .filter((property) => fit.uniquePropertyIds.includes(property.propertyId)),
        artifactRefs: ontology.listArtifactRefProperties(type.objectTypeId),
        counts: { objects: 0, links: 0, points: 0, vectors: 0, droppedLinks: 0 },
        skippedVectors: new Map(),
        ...travel,
        projectedPropertyIds: travel.source
          ? new Set()
          : projectedPropertyIds(type, objectType, ontology, projections),
        nextOrdinal: 0,
      }
      this.#types.set(type.objectTypeId, typePlan)
      if (typePlan.source) this.#byProjection.set(typePlan.source.projectionId, typePlan)
    }
  }

  /** The sources the load takes over, written before any of their roots. */
  sources(): readonly SnapshotSourceWrite[] {
    return [...this.#byProjection.values()].flatMap((plan) => (plan.source ? [plan.source] : []))
  }

  /** The type a projection's roots load into, when its source is taken over. */
  sourceType(projectionId: string): TypePlan | undefined {
    return this.#byProjection.get(projectionId)
  }

  get valueTypes() {
    return this.#ontology.getValueTypesById()
  }

  type(objectTypeId: string): TypePlan | undefined {
    return this.#types.get(objectTypeId)
  }

  objectTypeIds(): readonly string[] {
    return [...this.#types.keys()]
  }

  uniqueProperties(): readonly PreparedUniqueProperty[] {
    return [...this.#types.values()].flatMap((plan) =>
      plan.unique.map((property) => ({
        objectTypeId: plan.manifest.objectTypeId,
        propertyId: property.propertyId,
        keyKind: property.kind,
        keyVersion: UNIQUE_VALUE_KEY_VERSION,
      }))
    )
  }

  /** The shapes production recorded, which the branch records as its own before its gate runs. */
  recorded(): readonly { readonly objectTypeId: string; readonly shape: SnapshotTypeShape }[] {
    return [...this.#types.values()].flatMap((plan) =>
      plan.fit.recorded
        ? [{ objectTypeId: plan.manifest.objectTypeId, shape: plan.fit.recorded }]
        : []
    )
  }

  /**
   * The properties whose values the copy doesn't hold, by type: hidden from the person, or keys
   * production no longer declares, whose values don't travel.
   */
  unseenProperties(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map(
      [...this.#types.values()].map((plan) => [
        plan.manifest.objectTypeId,
        new Set([...plan.manifest.hiddenPropertyIds, ...plan.fit.withheld]),
      ])
    )
  }

  /**
   * The properties whose values the copy holds as edits where production holds a projection's:
   * a deploy reads only edits, so the copy can't tell what it would find.
   */
  projectedProperties(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map(
      [...this.#types.values()].map((plan) => [
        plan.manifest.objectTypeId,
        plan.projectedPropertyIds,
      ])
    )
  }

  /** Counts the objects of a type skipped from its shapes, for what a deploy would say. */
  holdsSkippedType(objectTypeId: string, objects: number): void {
    const held = this.#skippedHeld.get(objectTypeId)
    if (held) held.count += objects
  }

  /**
   * The types left out, with the line a deploy prints for a removed type, or one whose primary
   * property changed, that holds objects.
   */
  skips(): readonly SnapshotSkip[] {
    return this.#skipped.map((skip) => {
      const held = this.#skippedHeld.get(skip.objectTypeId)
      if (!held || held.count === 0) return skip

      const line = finding(skip.objectTypeId, held.change, held.count)
      return { ...skip, findings: formatTypeShapeFindings([line]) }
    })
  }

  /** Per type, the required properties hidden from the person, for types that have any. */
  requiredHiddenPropertyIds(): Record<string, readonly string[]> {
    const withheld: Record<string, readonly string[]> = {}
    for (const plan of this.#types.values()) {
      if (plan.requiredHiddenPropertyIds.length === 0) continue
      withheld[plan.manifest.objectTypeId] = plan.requiredHiddenPropertyIds
    }
    return withheld
  }

  /**
   * Whether the branch keeps a link: its definition still fits, or a pending step removes it, and
   * its target was imported.
   */
  keepsLink(plan: TypePlan, linkId: string, targetTypeId: string): boolean {
    if (plan.droppedLinkIds.has(linkId) || !this.#types.has(targetTypeId)) return false
    if (plan.fit.movedLinks.has(linkId)) return true

    const link = plan.objectType.links.find((candidate) => candidate.id === linkId)
    return (
      link !== undefined && this.#ontology.isValidLinkTarget(link.targetObjectTypeId, targetTypeId)
    )
  }

  report(
    migration: OntologyMigrationRunRecord | null,
    check: TypeShapeCheck
  ): readonly ImportedSnapshotType[] {
    const run = new Map(migration?.plan.types.map((type) => [type.objectTypeId, type]))
    const checked = new Map(check.types.map((type) => [type.objectTypeId, type]))

    return [...this.#types.values()].map((plan) => ({
      objectTypeId: plan.manifest.objectTypeId,
      objects: plan.counts.objects,
      links: plan.counts.links,
      points: plan.counts.points,
      vectors: plan.counts.vectors,
      hiddenPropertyIds: plan.manifest.hiddenPropertyIds,
      throughCondition: plan.manifest.throughCondition,
      requiredHiddenPropertyIds: plan.requiredHiddenPropertyIds,
      droppedPropertyIds: [...plan.droppedPropertyIds],
      droppedLinks: plan.counts.droppedLinks,
      skippedVectors: [...plan.skippedVectors].map(([profile, reason]) => ({ profile, reason })),
      migrationIds: [
        ...new Set(run.get(plan.manifest.objectTypeId)?.steps.map((step) => step.migrationId)),
      ],
      refusedByDeploy: refusedByDeploy(plan),
      unchecked: unchecked(plan, checked.get(plan.manifest.objectTypeId)),
      ...(plan.manifest.projection
        ? {
            projectionId: plan.manifest.projection.projectionId,
            reprojectable: plan.source !== undefined,
            ...(plan.notReprojectable === undefined
              ? {}
              : { notReprojectable: plan.notReprojectable }),
          }
        : {}),
    }))
  }
}

/**
 * The removals the copy left out that production's objects hold: a deploy of the branch's code
 * refuses each one, with the gate's own line, counted on the copy, or by production for a key its
 * code no longer declares, whose values don't travel.
 */
function refusedByDeploy(plan: TypePlan): readonly string[] {
  const objectTypeId = plan.manifest.objectTypeId
  const held = (change: ProbedChange) =>
    change.kind === "property-removed"
      ? (plan.heldProperties.get(change.propertyId) ?? 0)
      : "linkId" in change
        ? (plan.heldLinks.get(change.linkId)?.size ?? 0)
        : 0

  // Production says a withheld key is held, never by how many objects.
  const findings = [
    ...plan.fit.refusedWithheld.map((change) =>
      heldFinding(objectTypeId, change, plan.fit.remedy(change))
    ),
    ...plan.fit.leftOut.flatMap((change) => {
      const count = held(change)
      return count > 0 ? [finding(objectTypeId, change, count, plan.fit.remedy(change))] : []
    }),
  ]
  return formatTypeShapeFindings(findings)
}

/**
 * What a deploy would read that the copy can't: changes of properties hidden from the person, and
 * of keys whose values didn't travel. Each says it was not checked.
 */
function unchecked(plan: TypePlan, check: TypeShapeTypeCheck | undefined): readonly string[] {
  const objectTypeId = plan.manifest.objectTypeId

  // A withheld key a deploy refuses reads as a refusal, not as unchecked.
  const refused = (change: NarrowedChange) =>
    plan.fit.refusedWithheld.some((left) => sameChange(left, change))
  // A hidden property has no value on the copy; a projected one has its values only as edits.
  const hidden = new Set([...plan.manifest.hiddenPropertyIds, ...plan.fit.withheld])
  const of = (properties: ReadonlySet<string>, change: NarrowedChange) =>
    "propertyId" in change &&
    (properties.has(change.propertyId) || properties.has(plan.fit.storedKey(change.propertyId)))
  const projected = (change: NarrowedChange) =>
    of(plan.projectedPropertyIds, change) && !of(hidden, change)

  // The unique dry run reads the values the copy holds: it finds no duplicate where it holds none.
  const unique = (check?.changes ?? []).filter(
    (change): change is NarrowedChange =>
      change.kind === "property-unique" && narrows(change) && of(hidden, change)
  )

  const lines = [...plan.fit.unchecked, ...(check?.unseen ?? []), ...unique]
    .filter((change) => !refused(change))
    .map((change) =>
      uncheckedLine(objectTypeId, change, projected(change) ? "projected" : "hidden")
    )

  return [...new Set(lines)]
}

function sameChange(left: NarrowedChange, right: NarrowedChange): boolean {
  return (
    left.kind === right.kind &&
    ("propertyId" in left ? left.propertyId : undefined) ===
      ("propertyId" in right ? right.propertyId : undefined)
  )
}

/** The change a deploy refuses for a type skipped from its shapes, which its objects then hold. */
function skippedChange(
  kind: SnapshotSkipKind,
  type: SnapshotTypeManifest,
  ontology: OntologyRegistry
): Extract<ProbedChange, { kind: "type-removed" | "primary" }> | null {
  if (kind === "removed") return { kind: "type-removed", effect: "refused" }
  if (kind !== "primary") return null

  const to = ontology.getPrimaryPropertyId(type.objectTypeId)
  return { kind: "primary", from: type.primaryPropertyId, to, effect: "refused" }
}

/** Load every record after the members, and return the snapshot's end. */
async function loadRecords(
  records: AsyncIterator<SnapshotRecord>,
  plan: ImportPlan,
  loader: SnapshotLoader,
  commitId: string
): Promise<SnapshotEnd> {
  // The next frame is read and decompressed while the provider writes this one.
  const ahead = () => {
    const next = records.next()
    next.catch(() => undefined)
    return next
  }

  for (let pending = ahead(), next = await pending; !next.done; next = await pending) {
    pending = ahead()
    const record = next.value

    switch (record.kind) {
      case "objects":
        plan.read.objects += record.ids.length
        await loadObjects(plan, loader, record)
        break
      case "links":
        plan.read.links += record.rows.length
        await loadLinks(plan, loader, record)
        break
      case "points":
        plan.read.points += record.rows.length
        await loadPoints(plan, loader, record)
        break
      case "vectors":
        plan.read.vectors += record.ids.length
        await loadVectors(plan, loader, record, commitId)
        break
      case "sourceRoots":
        plan.read.sourceRoots += record.roots.length
        await loadSourceRoots(plan, loader, record)
        break
      case "edits":
        plan.read.edits += record.objects.length + record.links.length + record.slots.length
        await loadEdits(plan, loader, record)
        break
      case "end":
        // What was read ahead is what follows the end: the stream must close there.
        if (!(await pending).done) {
          throw new Error("[Sixb] The snapshot cannot be read: frames follow its end.")
        }
        return record
      default:
        throw new Error(
          `[Sixb] The snapshot cannot be read: a '${record.kind}' frame is misplaced.`
        )
    }
  }

  throw new Error("[Sixb] The snapshot cannot be read: its end is missing.")
}

async function loadObjects(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotObjects) {
  const type = plan.type(record.objectTypeId)
  if (!type) {
    plan.holdsSkippedType(record.objectTypeId, record.ids.length)
    return
  }

  const objectTypeId = record.objectTypeId
  const valueTypes = plan.valueTypes
  const objects: SnapshotObjectWrite[] = []
  const uniqueValues: ExactUniqueValueClaim[] = []
  const artifactHolders: ExactArtifactHolderWrite[] = []

  fromColumns(record).forEach((properties, index) => {
    const primaryId = record.ids[index]!

    const edited: Record<string, JsonValue> = {}
    for (const propertyId in properties) {
      if (!type.fit.keeps(propertyId)) {
        const held = type.heldProperties.get(propertyId)
        if (held !== undefined) type.heldProperties.set(propertyId, held + 1)

        type.droppedPropertyIds.add(propertyId)
        delete properties[propertyId]
      } else if (!type.telemetryPropertyIds.has(propertyId)) {
        edited[propertyId] = properties[propertyId]!
      }
    }

    objects.push({
      objectTypeId,
      primaryId,
      properties,
      // An object its source asserts is its source's, with the edits over it.
      ...(type.source ? {} : { override: { kind: "create" as const, properties: edited } }),
      createdAt: new Date(record.createdAt[index]!).toISOString(),
      updatedAt: new Date(record.updatedAt[index]!).toISOString(),
    })

    for (const { propertyId, kind } of type.unique) {
      const valueKey = uniqueValueKey(kind, properties[propertyId])
      if (valueKey === null) continue
      uniqueValues.push({
        objectTypeId,
        propertyId,
        valueKey,
        primaryId,
        keyKind: kind,
        keyVersion: UNIQUE_VALUE_KEY_VERSION,
      })
    }

    for (const property of type.artifactRefs) {
      const value = properties[property.id]
      if (value === undefined) continue
      for (const artifactId of collectArtifactRefIds(
        property.schema,
        value,
        valueTypes,
        new Set()
      )) {
        artifactHolders.push({ objectTypeId, primaryId, propertyId: property.id, artifactId })
      }
    }
  })

  type.counts.objects += objects.length
  await loader.write({ objects, uniqueValues, artifactHolders })
}

async function loadLinks(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotLinks) {
  const type = plan.type(record.sourceTypeId)
  if (!type) return

  const links: SnapshotLinkWrite[] = []
  for (const [
    sourceId,
    linkId,
    targetTypeId,
    targetId,
    createdAt,
    updatedAt,
    properties,
  ] of record.rows) {
    if (!plan.keepsLink(type, linkId, targetTypeId)) {
      type.heldLinks.get(linkId)?.add(sourceId)
      type.counts.droppedLinks += 1
      continue
    }

    const cardinality =
      type.objectType.links.find((link) => link.id === linkId)?.cardinality ??
      type.fit.movedLinks.get(linkId)
    links.push({
      sourceTypeId: record.sourceTypeId,
      sourceId,
      linkId,
      targetTypeId,
      targetId,
      ...(properties === null ? {} : { properties }),
      identity: type.source ? "source" : cardinality === "one" ? "slot" : "edge",
      createdAt: new Date(createdAt).toISOString(),
      updatedAt: new Date(updatedAt).toISOString(),
    })
  }

  type.counts.links += links.length
  if (links.length > 0) await loader.write({ links })
}

async function loadPoints(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotPoints) {
  const type = plan.type(record.objectTypeId)
  if (!type) return

  const points = record.rows
    .filter(([, propertyId]) => type.telemetryPropertyIds.has(propertyId))
    .map(([objectId, propertyId, value, unit, at]) => ({
      objectTypeId: record.objectTypeId,
      objectId,
      propertyId,
      value,
      ...(unit === null ? {} : { unit }),
      at: new Date(at).toISOString(),
    }))

  type.counts.points += points.length
  if (points.length > 0) await loader.write({ points })
}

/** Vectors are kept only when the branch embeds the profile exactly as production did. */
async function loadVectors(
  plan: ImportPlan,
  loader: SnapshotLoader,
  record: SnapshotVectors,
  commitId: string
) {
  const type = plan.type(record.objectTypeId)
  if (!type) return

  const profile = type.objectType.search?.vectors?.[record.profile]
  if (!profile) {
    type.skippedVectors.set(record.profile, "the branch no longer defines this profile")
    return
  }
  if (vectorConfiguration(profile) !== record.configuration) {
    type.skippedVectors.set(
      record.profile,
      "the branch embeds it differently: its vectors are computed again"
    )
    return
  }

  const bytes = Buffer.from(record.values, "base64")
  const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4)
  const vectors = record.ids.map((primaryId, index) => ({
    ref: { objectTypeId: record.objectTypeId, primaryId },
    profile: record.profile,
    configuration: record.configuration,
    source: record.source,
    sourceFingerprint: record.sourceFingerprints[index]!,
    values: Array.from(values.subarray(index * record.dimensions, (index + 1) * record.dimensions)),
    lastCommitId: commitId,
  }))

  type.counts.vectors += vectors.length
  await loader.write({ vectors })
}

async function loadSourceRoots(
  plan: ImportPlan,
  loader: SnapshotLoader,
  record: SnapshotSourceRoots
) {
  const type = plan.sourceType(record.projectionId)
  const source = type?.source
  if (!type || !source) return

  const sourceRoots = record.roots.map(([root, assertions]) => ({
    projectionId: source.projectionId,
    materializationId: source.materializationId,
    rootKey: projectionEntityKey(root),
    root,
    stagingOrdinal: type.nextOrdinal++,
    assertions,
  }))
  await loader.write({ sourceRoots })
}

/** The edits over a type that loads as its source; one loaded as created objects needs none. */
async function loadEdits(plan: ImportPlan, loader: SnapshotLoader, record: SnapshotEdits) {
  const type = plan.type(record.objectTypeId)
  if (!type?.source) return

  const objectTypeId = record.objectTypeId
  await loader.write({
    edits: {
      objects: record.objects.map(([primaryId, value, editedAt, updatedAt]) => ({
        ref: { objectTypeId, primaryId },
        value,
        ...(editedAt === null ? {} : { editedAt }),
        updatedAt: new Date(updatedAt).toISOString(),
      })),
      links: record.links
        .filter(([ref]) => plan.keepsLink(type, ref.linkId, ref.target.objectTypeId))
        .map(([ref, value, updatedAt]) => ({
          ref,
          value,
          updatedAt: new Date(updatedAt).toISOString(),
        })),
      slots: record.slots
        .filter(([, linkId, value]) => plan.keepsLink(type, linkId, value.target.objectTypeId))
        .map(([primaryId, linkId, value, updatedAt]) => ({
          source: { objectTypeId, primaryId },
          linkId,
          value,
          updatedAt: new Date(updatedAt).toISOString(),
        })),
    },
  })
}

/**
 * The properties a projection feeds on a type loaded as created objects: those production's feeds,
 * as the snapshot names them, and those the branch's feed, a property one newly feeds included. A
 * snapshot taken before it named them names none: the branch's projection of the same id says, or
 * else every property but the primary may be the projection's.
 */
function projectedPropertyIds(
  type: SnapshotTypeManifest,
  objectType: ObjectType,
  ontology: OntologyRegistry,
  projections: ProjectionDefinitionCatalog | undefined
): ReadonlySet<string> {
  const projection = type.projection
  if (!projection) return new Set()

  const definitions = projections?.listObjects() ?? []
  const fed = definitions.flatMap((definition) =>
    computeProjectionOwnership(definition, ontology).objects.flatMap((owned) =>
      owned.objectTypeId === type.objectTypeId ? owned.propertyIds : []
    )
  )
  if (projection.propertyIds) return new Set([...projection.propertyIds, ...fed])

  const continued = definitions.some(
    (definition) =>
      definition.id === projection.projectionId && definition.objectTypeId === type.objectTypeId
  )
  if (continued) return new Set(fed)

  const propertyIds = [
    ...Object.keys(type.shape?.fits.properties ?? {}),
    ...objectType.properties.map((property) => property.id),
  ]
  return new Set(propertyIds.filter((propertyId) => propertyId !== type.primaryPropertyId))
}

/**
 * A type travels as its source when the branch can continue it: the branch still defines it
 * whole, and its projection of the same id still feeds it from the same dataset.
 */
function sourceTravel(
  type: SnapshotTypeManifest,
  fit: LoadingFit,
  projections: ProjectionDefinitionCatalog | undefined
): Pick<TypePlan, "source" | "notReprojectable"> {
  const projection = type.projection
  if (!projection) return {}
  if (!projection.source) {
    return { notReprojectable: projection.notReprojectable ?? "its source did not travel" }
  }

  const branch = projections
    ?.listObjects()
    .find((definition) => definition.id === projection.projectionId)
  if (
    !branch ||
    branch.objectTypeId !== type.objectTypeId ||
    branch.datasetId !== projection.datasetId
  ) {
    return { notReprojectable: "the branch's projection no longer feeds it from that dataset" }
  }
  if (fit.droppedPropertyIds.length > 0 || fit.droppedLinkIds.length > 0) {
    return { notReprojectable: "the branch dropped some of its properties or links" }
  }

  return {
    source: {
      projectionId: projection.projectionId,
      materializationId: `snapshot_${randomUUID()}`,
      ...projection.source,
    },
  }
}

/**
 * Members go in before the objects, in a transaction of their own: they are not part of the
 * ontology's commit. They are written so that a load taken again after a failure finds them.
 */
async function importMembers(
  storage: SnapshotLoadStorage,
  projectId: string,
  members: SnapshotMembers
): Promise<number> {
  const auth = storage.auth
  if (!auth || members.users.length === 0) return 0

  await storage.transaction(async (tx) => {
    const store = tx.auth ?? auth

    for (const [id, email, displayName, avatarUrl, status, createdAt, updatedAt] of members.users) {
      // A load that failed before leaves its members: taking the snapshot again keeps them.
      if (await store.users.getById({ projectId, id })) continue

      await store.users.create({
        id,
        projectId,
        email,
        ...(displayName === null ? {} : { displayName }),
        ...(avatarUrl === null ? {} : { avatarUrl }),
        status,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
      })
    }

    for (const [userId, groupId, source, createdAt] of members.memberships) {
      await store.groupMemberships.upsert({
        projectId,
        userId,
        groupId,
        source,
        createdAt: new Date(createdAt),
      })
    }
  })

  return members.users.length
}
