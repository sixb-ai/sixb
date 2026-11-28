import type { JsonValue } from "../../json"
import { coverChanges, type MigrationCoverage } from "../../migrations/coverage"
import { CONFLICT_REMEDY } from "../../migrations/messages"
import { concerningMigrations, type PlannedStep } from "../../migrations/pending"
import { runRenames } from "../../migrations/run"
import { stepKindOf } from "../../migrations/steps"
import type { MigrationDefinition } from "../../migrations/types"
import type { OntologyDefinitionCatalog } from "../../ontology/registry"
import {
  diffTypeShapes,
  type LinkShape,
  type PropertyShape,
  sameShape,
  type TypeShape,
  type TypeShapeChange,
  typeShape,
  withoutRemovedTargets,
} from "../../ontology/type-shapes"
import type { ObjectType, Property, ValueType } from "../../ontology/types"
import { validatePropertyValue } from "../../ontology/validation"
import type {
  StoredObjectEdit,
  StoredTypeShape,
  TypeShapeProbe,
  TypeShapeProbeInput,
} from "../ontology/type-shapes"
import type { Storage } from "../types"
import { findUniqueDuplicates, madeUnique } from "./prepare-unique-properties"
import {
  duplicateFinding,
  finding,
  mismatchMessage,
  type NarrowedChange,
  narrows,
  needsData,
  type ProbedChange,
  type TypeShapeFinding,
  unprobedFinding,
} from "./type-shape-messages"

export { formatTypeShapeFindings, type TypeShapeFinding } from "./type-shape-messages"

/**
 * What the ontology step of `migrateStorage` may do with the stored shapes:
 *
 * - `check`: compares and probes, and writes nothing. `sixb db migrate --check`, `sixb check`.
 * - `deploy`: compares and probes, then records the code's shapes, or throws
 *   {@link TypeShapeMismatchError} and records nothing. `sixb db migrate`, `sixb check --migrate`.
 * - `dev`: compares and probes, records the types whose data fits, and warns about the others.
 * - `role`: never probes ({@link roleCheck}). Records what the code adds or widens, starts the
 *   release before the recorded shape as it is, and throws on anything else. Records the code's
 *   shape for a new type that holds no data yet.
 */
export type TypeShapeMode = "check" | "deploy" | "dev" | "role"

export interface TypeShapeTypeCheck {
  readonly objectTypeId: string
  /** The stored row this check read, or `null` when none was recorded yet. */
  readonly stored: StoredTypeShape | null
  /** What the data fits when nothing was stored: the first deploy's validation pass. */
  readonly baseline?: TypeShape
  /** From the stored shape (or the baseline) to the code's. */
  readonly changes: readonly TypeShapeChange[]
  readonly findings: readonly TypeShapeFinding[]
  /**
   * Whether the old release must stop before this shape is recorded: a change that isn't
   * compatible, or a first shape over data the old release may still write differently.
   */
  readonly pausesWrites: boolean
  /** What recording writes: the code's shape, the baseline, the row's removal, or nothing. */
  readonly next:
    | { readonly kind: "write"; readonly shape: TypeShape }
    | { readonly kind: "remove" }
    | { readonly kind: "keep" }
  /**
   * The pending migration steps a deploy applies before recording, by migration and position in
   * its chain: those whose changes data holds, in the order they run. A change data holds that a
   * step this build can't apply resolves is a finding instead.
   */
  readonly run: readonly { readonly migrationId: string; readonly index: number }[]
  /**
   * The migrations settled when the code's shape is recorded, or found already recorded: every one
   * that concerns the type and isn't settled yet.
   */
  readonly settles: readonly string[]
}

export interface TypeShapeCheck {
  readonly projectId: string
  readonly mode: TypeShapeMode
  readonly types: readonly TypeShapeTypeCheck[]
  /** Something the data doesn't fit: a deploy stops before anything is written. */
  readonly blocked: boolean
  /** Some type's `pausesWrites`: `sixb db migrate --check` exits 3 for it. */
  readonly narrows: boolean
  /** Types holding data that have no stored shape, which a role leaves for `sixb db migrate`. */
  readonly unrecorded: readonly string[]
  /**
   * Types a migration run is being applied to, past its point of no return: only `check` returns
   * them, with nothing else; every other mode throws {@link OntologyMigrationApplyingError}.
   */
  readonly applying: readonly string[]
}

/** The code changes a type in a way its stored objects don't fit. */
export class TypeShapeMismatchError extends Error {
  readonly findings: readonly TypeShapeFinding[]

  constructor(check: TypeShapeCheck) {
    const findings = check.types.flatMap((type) => type.findings)
    super(mismatchMessage(check.mode === "role", findings))
    this.name = "TypeShapeMismatchError"
    this.findings = findings
  }
}

/** A migration run is past its point of no return: only finishing it goes forward. */
export class OntologyMigrationApplyingError extends Error {
  readonly objectTypeIds: readonly string[]

  constructor(objectTypeIds: readonly string[]) {
    super(
      `[Sixb] An ontology migration is being applied to ${objectTypeIds.join(", ")}. ` +
        "Run `sixb db migrate` to finish it, then start again."
    )
    this.name = "OntologyMigrationApplyingError"
    this.objectTypeIds = objectTypeIds
  }
}

/** Objects and edits read per page by the validation passes. */
const PAGE_ROWS = 1_000

/**
 * Compares each type's stored shape with the code's and, unless `mode` is `role`, reads the data
 * for every change that isn't compatible. Writes nothing: {@link recordTypeShapes} does.
 */
export async function checkTypeShapes(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  /** The project's migrations: a change their pending steps cover isn't missing one. */
  readonly migrations?: readonly MigrationDefinition[]
  readonly mode: TypeShapeMode
  /**
   * Runs the unique preparation's dry run, as `applyTypeShapes` does before anything is written,
   * and words a duplicate as its type's finding: `sixb db migrate --check` fails on it before the
   * live release stops, as on any other data that doesn't fit.
   */
  readonly uniqueDuplicates?: boolean
}): Promise<TypeShapeCheck> {
  const { storage, projectId, ontology, mode } = input
  const migrations = input.migrations ?? []
  const stored = await storage.ontology.typeShapes.list({ projectId })
  const storedById = new Map(stored.map((row) => [row.objectTypeId, row]))

  // A run past its point of no return: nothing but finishing it may happen.
  const applying = stored.filter((row) => row.state === "migrating").map((row) => row.objectTypeId)
  if (applying.length > 0) {
    if (mode !== "check") throw new OntologyMigrationApplyingError(applying)
    return { projectId, mode, types: [], blocked: false, narrows: true, unrecorded: [], applying }
  }
  const settled = await settledByType(storage, projectId, migrations)

  const objectTypeIds = [
    ...ontology.listObjectTypes().map((objectType) => objectType.id),
    ...stored.map((row) => row.objectTypeId).filter((id) => !ontology.getObjectTypeById(id)),
  ]

  const types: TypeShapeTypeCheck[] = []
  const unrecorded: string[] = []
  for (const objectTypeId of objectTypeIds) {
    const checked = await checkType({
      storage,
      projectId,
      ontology,
      mode,
      migrations,
      objectType: ontology.getObjectTypeById(objectTypeId),
      objectTypeId,
      stored: storedById.get(objectTypeId) ?? null,
      settled: settled.get(objectTypeId) ?? new Set(),
    })
    if (checked === "unrecorded") unrecorded.push(objectTypeId)
    else types.push(checked)
  }
  if (input.uniqueDuplicates) {
    types.splice(0, types.length, ...(await withUniqueDuplicates(input, migrations, types)))
  }

  return {
    projectId,
    mode,
    types,
    blocked: types.some((type) => type.findings.length > 0),
    narrows: types.some((type) => type.pausesWrites),
    unrecorded,
    applying: [],
  }
}

/** The migrations each type has settled, read only when the project declares any. */
async function settledByType(
  storage: Storage,
  projectId: string,
  migrations: readonly MigrationDefinition[]
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const byType = new Map<string, Set<string>>()
  if (migrations.length === 0 || !storage.ontology.migrations) return byType

  for (const row of await storage.ontology.migrations.listSettled({ projectId })) {
    const settled = byType.get(row.objectTypeId) ?? new Set<string>()
    settled.add(row.migrationId)
    byType.set(row.objectTypeId, settled)
  }

  return byType
}

/**
 * The types with what the unique dry run finds: two objects sharing a value of a property the code
 * makes unique. A type that finds one records nothing, as a type with any other finding.
 */
async function withUniqueDuplicates(
  input: {
    readonly storage: Storage
    readonly projectId: string
    readonly ontology: OntologyDefinitionCatalog
  },
  migrations: readonly MigrationDefinition[],
  types: readonly TypeShapeTypeCheck[]
): Promise<TypeShapeTypeCheck[]> {
  const unfit = new Set(
    types.filter((type) => type.findings.length > 0).map((type) => type.objectTypeId)
  )
  const duplicates = await findUniqueDuplicates({
    storage: input.storage,
    projectId: input.projectId,
    ontology: input.ontology,
    keepObjectTypeIds: unfit,
    rebuild: madeUnique(types),
    renames: runRenames({ types }, migrations),
  })

  return types.map((type) => {
    const found = duplicates.filter((duplicate) => duplicate.objectTypeId === type.objectTypeId)
    if (found.length === 0) return type

    const findings = found.map(({ propertyId, violation }) =>
      duplicateFinding(type.objectTypeId, propertyId, violation)
    )
    return {
      ...type,
      findings: [...type.findings, ...findings],
      next: { kind: "keep" },
      run: [],
      settles: [],
    }
  })
}

/**
 * Writes what `check` decided, in one transaction that first takes the shapes' lock. A row that
 * changed since it was read fails the recording, unless it already holds what would be written:
 * roles starting together record the same shape once. Nothing to write takes no lock.
 */
export async function recordTypeShapes(storage: Storage, check: TypeShapeCheck): Promise<void> {
  const { projectId } = check
  const writes = check.types.filter((type) => type.next.kind !== "keep")
  // A type whose stored shape already is the code's settles too: a shape a role recorded before
  // it knew the migrations, or one recorded with none declared yet.
  const settles = check.types.flatMap((type) =>
    type.settles.map((migrationId) => ({ objectTypeId: type.objectTypeId, migrationId }))
  )
  if (writes.length === 0 && settles.length === 0) return

  await storage.transaction(async (tx) => {
    const shapes = tx.ontology.typeShapes
    await shapes.lock({ projectId })

    const rows = await shapes.list({ projectId })
    // A run started since the check: its shapes are its own until it finishes.
    const applying = rows.filter((row) => row.state === "migrating")
    if (applying.length > 0) {
      throw new OntologyMigrationApplyingError(applying.map((row) => row.objectTypeId))
    }
    const current = new Map(rows.map((row) => [row.objectTypeId, row]))
    const updatedAt = new Date().toISOString()

    for (const type of writes) {
      const row = current.get(type.objectTypeId)
      const now = row?.shape ?? null
      const target = type.next.kind === "write" ? type.next.shape : null

      // Someone else recorded what this would: nothing left to do.
      if (sameShape(now, target)) continue

      if (!sameShape(now, type.stored?.shape ?? null)) {
        throw new Error(
          `[Sixb] The stored shape of '${type.objectTypeId}' changed while it was being checked. ` +
            "Run the command again."
        )
      }

      if (target) {
        // A role never changes what the release before the recorded shape defines; anything
        // else records the shape it replaces.
        const previous = check.mode === "role" ? (row?.previous ?? null) : now
        await shapes.write({
          projectId,
          objectTypeId: type.objectTypeId,
          shape: target,
          previous,
          updatedAt,
        })
      } else {
        await shapes.remove({ projectId, objectTypeId: type.objectTypeId })
      }
    }

    // In the same transaction as the shapes: a migration past which a shape is recorded never runs.
    if (settles.length > 0) {
      await tx.ontology.migrations?.settle({ projectId, migrations: settles, settledAt: updatedAt })
    }
  })
}

async function checkType(input: {
  readonly storage: Storage
  readonly projectId: string
  readonly ontology: OntologyDefinitionCatalog
  readonly mode: TypeShapeMode
  readonly migrations: readonly MigrationDefinition[]
  readonly objectType: ObjectType | null
  readonly objectTypeId: string
  readonly stored: StoredTypeShape | null
  readonly settled: ReadonlySet<string>
}): Promise<TypeShapeTypeCheck | "unrecorded"> {
  const { storage, projectId, ontology, mode, migrations, objectType, objectTypeId, stored } = input
  const { settled } = input
  const code = objectType ? typeShape(objectType, ontology) : null
  const settles = code
    ? concerningMigrations({ objectTypeId, ontology, migrations }).filter((id) => !settled.has(id))
    : []
  const unchanged = {
    objectTypeId,
    stored,
    changes: [],
    findings: [],
    pausesWrites: false,
    run: [],
    settles,
  }

  if (!stored) {
    if (!code) return { ...unchanged, next: { kind: "keep" } }

    // Nothing of the type is stored yet: the code's shape is what its data fits.
    const probe = { projectId, objectTypeId, probe: { kind: "type" } } as const
    if (!(await storage.ontology.typeShapes.holds(probe))) {
      return { ...unchanged, next: { kind: "write", shape: code } }
    }

    // A role reads nothing but the shapes, so it can't tell what this data fits.
    if (mode === "role") return "unrecorded"
  }

  if (mode === "role") {
    return roleCheck({ objectTypeId, stored: stored!, code, ontology, settles })
  }

  const baseline = stored
    ? undefined
    : await baselineShape(storage, projectId, objectType!, code!, ontology)
  // A stored link target the code no longer defines is a removed type, which its own change probes.
  const from = withoutRemovedTargets(stored?.shape ?? baseline!, ontology)
  const changes = diffTypeShapes(from, code)
  const narrowed = changes.filter(narrows)
  const pending = narrowed.filter(needsData)

  const probed = { storage, projectId, objectType, objectTypeId, ontology }
  const { findings, run } = code
    ? await migrationFindings({ ...probed, from, code, migrations, settled })
    : {
        findings: (await probeChanges({ ...probed, pending })).map(({ change, count }) =>
          finding(objectTypeId, change, count)
        ),
        run: [],
      }

  return {
    objectTypeId,
    stored,
    ...(baseline ? { baseline } : {}),
    changes,
    findings,
    // A first shape over stored data: the old release may still write keys this code drops. A
    // property made unique too: it may still write a value another object holds.
    pausesWrites: narrowed.length > 0 || baseline !== undefined,
    next: nextWrite({ mode, code, baseline, stored, findings }),
    run: findings.length > 0 ? [] : run,
    // A shape that isn't the code's leaves its migrations to run later.
    settles: findings.length > 0 ? [] : settles,
  }
}

/**
 * What a role does with a type's recorded shape. It reads no data, so whether the stored objects
 * fit its code has to follow from the shapes:
 *
 * - code that only adds or widens what is recorded: a compatible change, recorded;
 * - the code of the release before the recorded shape (`previous`), as when it starts again after
 *   a deploy: it starts, and keeps recorded what that deploy added or widened, so the next deploy
 *   still probes its removal. Something the deploy narrowed it records back as it defines it. A
 *   property it makes unique, or narrows where the deploy did too, is refused: a role can't build
 *   unique values, nor tell what the data fits;
 * - anything else is refused, for `sixb db migrate` to read the data: newer code than the
 *   recorded shape, or code older than the one before it.
 *
 * A type only the recorded shapes hold is a newer release's: the role neither reads nor writes it.
 */
function roleCheck(input: {
  readonly objectTypeId: string
  readonly stored: StoredTypeShape
  readonly code: TypeShape | null
  readonly ontology: OntologyDefinitionCatalog
  /** What a shape it starts on settles, as for any mode: a role runs no migration. */
  readonly settles: readonly string[]
}): TypeShapeTypeCheck {
  const { objectTypeId, stored, code, settles } = input
  const recorded = withoutRemovedTargets(stored.shape, input.ontology)
  const changes = diffTypeShapes(recorded, code)
  const kept = { objectTypeId, stored, changes, pausesWrites: false, run: [], settles } as const
  const keep = { ...kept, findings: [], next: { kind: "keep" } } as const
  if (!code) return keep

  const narrowed = changes.filter(narrows)
  if (narrowed.length === 0) {
    return sameShape(stored.shape, code) ? keep : { ...keep, next: { kind: "write", shape: code } }
  }

  const refuse = (refused: readonly NarrowedChange[]): TypeShapeTypeCheck => ({
    ...keep,
    findings: refused.map((change) => unprobedFinding(objectTypeId, change)),
    settles: [],
  })
  if (!stored.previous || !sameShape(stored.previous, code)) return refuse(narrowed)

  // The release before, started again: each property and link the deploy changed, alone.
  const reverse = groupByKey(diffTypeShapes(code, recorded))
  const properties = { ...code.properties }
  const links = { ...code.links }
  const refused: NarrowedChange[] = []

  for (const [key, forward] of groupByKey(changes)) {
    if (forward.every((change) => !narrows(change))) continue

    // A primary property is the type's, not a key's: it is never kept from the recorded shape.
    const widenedInStore =
      key !== TYPE_KEY &&
      !forward.some((change) => change.kind === "property-unique") &&
      (reverse.get(key) ?? []).every((change) => !narrows(change))
    if (!widenedInStore) {
      refused.push(...forward.filter(narrows))
      continue
    }

    const [kind, id] = JSON.parse(key) as ["property" | "link", string]
    const target: Record<string, unknown> = kind === "property" ? properties : links
    const definition = kind === "property" ? recorded.properties[id] : recorded.links[id]
    if (definition) target[id] = definition
    else delete target[id]
  }
  if (refused.length > 0) return refuse(refused)

  const merged = { properties: sortKeys(properties), links: sortKeys(links) }
  return sameShape(stored.shape, merged)
    ? keep
    : { ...keep, next: { kind: "write", shape: merged } }
}

/** The key of a change that belongs to no property or link: the primary property, the type. */
const TYPE_KEY = "type"

/** Changes by the property or link they belong to, in the order they came. */
function groupByKey(changes: readonly TypeShapeChange[]): Map<string, TypeShapeChange[]> {
  const groups = new Map<string, TypeShapeChange[]>()
  for (const change of changes) {
    const key =
      "propertyId" in change
        ? JSON.stringify(["property", change.propertyId])
        : "linkId" in change
          ? JSON.stringify(["link", change.linkId])
          : TYPE_KEY
    groups.set(key, [...(groups.get(key) ?? []), change])
  }
  return groups
}

function nextWrite(input: {
  readonly mode: TypeShapeMode
  readonly code: TypeShape | null
  readonly baseline: TypeShape | undefined
  readonly stored: StoredTypeShape | null
  readonly findings: readonly TypeShapeFinding[]
}): TypeShapeTypeCheck["next"] {
  const { mode, code, baseline, stored, findings } = input

  if (findings.length > 0) {
    // `sixb dev` has no old release to protect: what the data fits is worth keeping, so a
    // migration added later has something to apply to. A deploy records nothing at all.
    if (mode === "dev" && baseline) return { kind: "write", shape: baseline }
    return { kind: "keep" }
  }

  if (!code) return { kind: "remove" }
  if (stored && sameShape(stored.shape, code)) return { kind: "keep" }
  return { kind: "write", shape: code }
}

interface ProbeInput {
  readonly storage: Storage
  readonly projectId: string
  readonly objectType: ObjectType | null
  readonly objectTypeId: string
  readonly ontology: OntologyDefinitionCatalog
}

/**
 * Each change the stored objects don't fit is covered by pending migration steps, or missing one.
 * Only the changes data holds count, so a removal nobody ever set needs nothing: a missing one is
 * a finding, a covered one runs its steps, unless storage can't apply them.
 */
async function migrationFindings(
  input: ProbeInput & {
    readonly from: TypeShape
    readonly code: TypeShape
    readonly migrations: readonly MigrationDefinition[]
    readonly settled: ReadonlySet<string>
  }
): Promise<{
  readonly findings: TypeShapeFinding[]
  readonly run: TypeShapeTypeCheck["run"]
}> {
  const { objectTypeId, ontology, from, code, migrations, settled } = input
  const classes = classifyTypeChanges({
    objectTypeId,
    from,
    code,
    ontology,
    migrations,
    settled,
    appliesMigrations: input.storage.ontology.migrations !== undefined,
  })
  if (classes.conflicts.length > 0) return { findings: [...classes.conflicts], run: [] }

  // Every change is read under the key the data holds it by, through pending renames.
  const { coverage } = classes
  const storedKey = coverage.storedKey
  const findings = (await probeChanges({ ...input, pending: classes.missing, storedKey })).map(
    ({ change, count }) => finding(objectTypeId, change, count, coverage.remedy(change))
  )

  // A change that runs only needs to know data holds it: the run counts what it rewrites.
  const runs = new Set<PlannedStep>()
  const runnable = await probeChanges({
    ...input,
    pending: classes.runnable,
    storedKey,
    count: false,
  })
  for (const { change } of runnable) {
    for (const planned of coverage.stepsFor(change)) runs.add(planned)
  }

  const blocked = await probeChanges({ ...input, pending: classes.blocked, storedKey })
  for (const { change, count } of blocked) {
    findings.push(finding(objectTypeId, change, count, coverage.remedy(change)))
  }

  const run = coverage.steps.filter((planned) => runs.has(planned))

  return { findings, run: run.map(({ migrationId, index }) => ({ migrationId, index })) }
}

/** The changes of one type, sorted by what decides them: {@link classifyTypeChanges}. */
interface TypeChangeClasses {
  /** Pending steps that can't both run: the type is refused for them, data or not. */
  readonly conflicts: readonly TypeShapeFinding[]
  /** Changes no pending step covers: a finding when data holds them. */
  readonly missing: readonly ProbedChange[]
  /** Changes pending steps cover and storage applies: they run when data holds them. */
  readonly runnable: readonly ProbedChange[]
  /**
   * Changes pending steps cover with a step this build or storage can't apply: a finding when
   * data holds them.
   */
  readonly blocked: readonly ProbedChange[]
  readonly coverage: MigrationCoverage<ProbedChange>
}

/**
 * What the shapes alone say of a type's changes, before any data is read: each change from `from`
 * to `code` that needs data is missing a migration, runnable or blocked.
 */
function classifyTypeChanges(input: {
  readonly objectTypeId: string
  readonly from: TypeShape
  readonly code: TypeShape
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  readonly settled: ReadonlySet<string>
  /** Whether the storage provider applies migrations: without it, no covered change runs. */
  readonly appliesMigrations: boolean
}): TypeChangeClasses {
  const { objectTypeId, from, code, ontology, migrations, settled } = input
  const coverage = coverChanges({
    objectTypeId,
    stored: from,
    code,
    changes: diffTypeShapes(from, code).filter(needsData),
    ontology,
    migrations,
    settled,
  })

  const conflicts = coverage.conflicts.map(({ change, message }) => ({
    objectTypeId,
    change,
    count: null,
    message,
    remedy: [CONFLICT_REMEDY],
  }))

  // A covered change runs when storage applies every step that resolves it: none without
  // migrations, and none of a kind this build doesn't apply yet.
  const applies = (change: ProbedChange) =>
    input.appliesMigrations &&
    coverage.stepsFor(change).every((planned) => stepKindOf(planned.step).storeStep)

  return {
    conflicts,
    missing: coverage.missing.filter(needsData),
    runnable: coverage.covered.filter(applies),
    blocked: coverage.covered.filter((change) => !applies(change)),
    coverage,
  }
}

/** What decides whether the data fits a change: a probe, or a pass over the edits' values. */
type ShapeRead =
  | TypeShapeProbe
  | {
      readonly kind: "values"
      /** The key the stored values are under. */
      readonly propertyId: string
      /** The property whose schema they must fit. */
      readonly codePropertyId: string
    }

/**
 * Reads the data for each change that isn't compatible, and counts only what fails. Two changes
 * can need the same read, such as a property retyped and no longer nullable: the read runs once,
 * and only the first change it belongs to counts. `storedKey` maps a property of the code to the
 * key the stored objects hold it by, through pending renames.
 */
async function probeChanges(
  input: ProbeInput & {
    readonly pending: readonly ProbedChange[]
    readonly storedKey?: (propertyId: string) => string
    /** `false` stops at the first holder, and counts it as one. */
    readonly count?: boolean
  }
): Promise<{ readonly change: ProbedChange; readonly count: number }[]> {
  const { storage, projectId, objectType, objectTypeId, ontology, pending } = input
  const storedKey = input.storedKey ?? ((propertyId: string) => propertyId)
  const done = new Set<string>()
  const held: { readonly change: ProbedChange; readonly count: number }[] = []

  for (const change of pending) {
    const read = readFor(change, storedKey)
    const key = JSON.stringify(read)
    if (done.has(key)) continue
    done.add(key)

    const count =
      read.kind === "values"
        ? await countUnfitEdits(storage, projectId, objectType!, read, ontology)
        : await countHolders(storage, { projectId, objectTypeId, probe: read }, input.count)
    if (count > 0) held.push({ change, count })
  }

  return held
}

function readFor(change: ProbedChange, storedKey: (propertyId: string) => string): ShapeRead {
  switch (change.kind) {
    case "type-removed":
    case "primary":
      return { kind: "type" }
    case "property-added":
    case "property-required":
      return { kind: "missingRequired", propertyId: storedKey(change.propertyId) }
    case "property-retyped":
    case "property-not-nullable": {
      const propertyId = storedKey(change.propertyId)
      // A telemetry change is refused: whether a series exists decides.
      if (change.effect === "refused") return { kind: "property", propertyId }
      return { kind: "values", propertyId, codePropertyId: change.propertyId }
    }
    case "property-removed":
    case "property-mode":
      return { kind: "property", propertyId: storedKey(change.propertyId) }
    case "link-added":
    case "link-removed":
    case "link-targets":
    case "link-cardinality":
      return { kind: "link", linkId: change.linkId }
  }
}

/** The probe stops at the first hit; only a hit pays for the count, when one is asked for. */
async function countHolders(
  storage: Storage,
  probe: TypeShapeProbeInput,
  count = true
): Promise<number> {
  const shapes = storage.ontology.typeShapes
  if (!(await shapes.holds(probe))) return 0
  return count ? shapes.count(probe) : 1
}

/**
 * Edits whose value of the property the code no longer accepts, by the framework's own validator.
 * Source values are left to the projection, which rebuilds them under the new schema. Only the
 * edits that set the property are read, once: the pass that finds the first unfit value counts
 * the rest.
 */
async function countUnfitEdits(
  storage: Storage,
  projectId: string,
  objectType: ObjectType,
  read: { readonly propertyId: string; readonly codePropertyId: string },
  ontology: OntologyDefinitionCatalog
): Promise<number> {
  const property = objectType.properties.find((candidate) => candidate.id === read.codePropertyId)!
  const valueTypes = ontology.getValueTypesById()
  let unfit = 0

  // The code's schema, over the values stored under the key the data still has.
  await forEachEdit(storage, projectId, objectType.id, read.propertyId, (edit) => {
    const values = edit.value.kind === "create" ? edit.value.properties : edit.value.set
    if (!fits(property, values[read.propertyId], valueTypes)) unfit += 1
  })

  return unfit
}

/**
 * The first deploy's validation pass: what the type's stored data fits, so the diff with the code
 * then shows what needs a migration like any other change. It lists only the keys the data holds,
 * and the primary property: a declared property nothing holds diffs as added, so a renamed key
 * reads as the old one removed and the new one added.
 *
 * - A held key the code declares takes the code's shape; one it doesn't, in an object, an edit or
 *   a telemetry series, is an unknown property. Links go the same way, from links, link edits and
 *   source rows.
 * - A declared property an edit gives a value its schema refuses has an unknown schema. Source
 *   values are left out: the projection rebuilds them under the code's schema.
 * - A held required property an object created by an action lacks, or an edit cleared, is not
 *   required.
 */
async function baselineShape(
  storage: Storage,
  projectId: string,
  objectType: ObjectType,
  code: TypeShape,
  ontology: OntologyDefinitionCatalog
): Promise<TypeShape> {
  const shapes = storage.ontology.typeShapes
  const valueTypes = ontology.getValueTypesById()
  const declared = new Map(objectType.properties.map((property) => [property.id, property]))
  const held = new Set<string>()
  const unfit = new Set<string>()

  let afterPrimaryId: string | undefined
  do {
    const page = await storage.objects.listByPrimaryIdPage({
      projectId,
      objectTypeId: objectType.id,
      limit: PAGE_ROWS,
      ...(afterPrimaryId === undefined ? {} : { afterPrimaryId }),
    })
    for (const object of page.objects) {
      for (const propertyId of Object.keys(object.properties)) held.add(propertyId)
    }
    afterPrimaryId = page.nextPrimaryId
  } while (afterPrimaryId !== undefined)

  await forEachEdit(storage, projectId, objectType.id, undefined, (edit) => {
    const values = edit.value.kind === "create" ? edit.value.properties : edit.value.set
    for (const [propertyId, value] of Object.entries(values)) {
      held.add(propertyId)

      const property = declared.get(propertyId)
      if (property && !unfit.has(propertyId) && !fits(property, value, valueTypes)) {
        unfit.add(propertyId)
      }
    }

    // An unset or an edit time holds the key without a value.
    const unset = edit.value.kind === "patch" ? edit.value.unset : []
    for (const propertyId of [...unset, ...Object.keys(edit.editedAt)]) held.add(propertyId)
  })

  const keys = await shapes.listHeldKeys({ projectId, objectTypeId: objectType.id })
  const series = new Set(keys.seriesPropertyIds)

  const properties: Record<string, PropertyShape> = {}
  const primaryId = ontology.getPrimaryPropertyId(objectType.id)
  for (const propertyId of new Set([primaryId, ...held, ...series])) {
    const property = code.properties[propertyId]
    if (!property) {
      properties[propertyId] = {
        // A series' latest point shows in its object too: the series says it is telemetry.
        ...(series.has(propertyId) ? { mode: "telemetry" as const } : {}),
        schema: "unknown",
        unknown: true,
      }
      continue
    }

    properties[propertyId] = unfit.has(propertyId) ? { ...property, schema: "unknown" } : property
    if (!property.required || property.primary || property.mode === "telemetry") continue

    const probe = { kind: "missingRequired", propertyId } as const
    if (await shapes.holds({ projectId, objectTypeId: objectType.id, probe })) {
      const { required: _required, ...optional } = properties[propertyId]!
      properties[propertyId] = optional
    }
  }

  const links: Record<string, LinkShape> = {}
  for (const linkId of keys.linkIds) {
    links[linkId] = code.links[linkId] ?? { cardinality: "many", targets: [], unknown: true }
  }

  return { properties: sortKeys(properties), links: sortKeys(links) }
}

/** Every `create` and `patch` edit of the type, or only those that set `withValueOf`. */
async function forEachEdit(
  storage: Storage,
  projectId: string,
  objectTypeId: string,
  withValueOf: string | undefined,
  visit: (edit: StoredObjectEdit) => void
): Promise<void> {
  let afterPrimaryId: string | undefined
  do {
    const page = await storage.ontology.typeShapes.listEdits({
      projectId,
      objectTypeId,
      limit: PAGE_ROWS,
      ...(withValueOf === undefined ? {} : { withValueOf }),
      ...(afterPrimaryId === undefined ? {} : { afterPrimaryId }),
    })
    for (const edit of page.edits) visit(edit)
    afterPrimaryId = page.nextPrimaryId
  } while (afterPrimaryId !== undefined)
}

function fits(
  property: Property,
  value: JsonValue | undefined,
  valueTypes: ReadonlyMap<string, ValueType>
): boolean {
  try {
    validatePropertyValue(property, value, property.id, valueTypes)
    return true
  } catch {
    return false
  }
}

function sortKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]!])
  )
}
