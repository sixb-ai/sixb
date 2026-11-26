import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { diffTypeShapes, type TypeShape, type TypeShapeChange } from "../ontology/type-shapes"
import { missingMigrationLines, pendingMigrationLine } from "./messages"
import { type PendingSteps, type PlannedStep, planPendingSteps } from "./pending"
import { stepKindOf } from "./steps"
import type { MigrationDefinition, OntologyMigrationStep } from "./types"

/** What the project's migrations do for the changes one type's stored objects don't fit. */
export interface MigrationCoverage<TChange extends TypeShapeChange> {
  /**
   * Pending steps that can't both run, each with a change of the subject they share: the type is
   * refused for them, data or not.
   */
  readonly conflicts: readonly { readonly change: TChange; readonly message: string }[]
  /** Changes still not compatible once the pending steps have run. */
  readonly missing: readonly TypeShapeChange[]
  /** Changes the pending steps resolve. */
  readonly covered: readonly TChange[]
  /**
   * What the value steps resolve, from the shape the renames leave: the convert of a renamed
   * property resolves no change of `stored`, where it was another property. Under their stored
   * keys, the data holds them or not, as the covered ones.
   */
  readonly valueChanges: readonly TypeShapeChange[]
  /** The pending steps, in the order they run. */
  readonly steps: readonly PlannedStep[]
  /** The pending steps that resolve a covered change. */
  stepsFor(change: TypeShapeChange): readonly PlannedStep[]
  /** The key the stored objects hold a property of the code by, through pending renames. */
  storedKey(propertyId: string): string
  /** What to do about a change data holds: the missing line, or the migrations that cover it. */
  remedy(change: TypeShapeChange): string[]
}

/**
 * Sorts `changes`, the ones from `stored` to `code` that aren't compatible, into those pending
 * migration steps cover and those still missing one. Reads no data: the gate probes both lists and
 * only the changes data holds count.
 */
export function coverChanges<TChange extends TypeShapeChange>(input: {
  readonly objectTypeId: string
  readonly stored: TypeShape
  readonly code: TypeShape
  readonly changes: readonly TChange[]
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  readonly settled?: ReadonlySet<string>
}): MigrationCoverage<TChange> {
  const { objectTypeId, stored, code, changes, ontology, migrations } = input
  const plan = planPendingSteps({
    objectTypeId,
    stored,
    ontology,
    migrations,
    ...(input.settled ? { settled: input.settled } : {}),
  })

  const missing = diffTypeShapes(plan.shape, code).filter(
    (change) => change.effect !== "compatible"
  )
  const covered = changes.filter((change) => !missing.some((left) => sameConcern(left, change)))
  const takenIds = new Set(migrations.map((migration) => migration.id))

  // The shape the renames leave, which the value steps start from.
  let keyed = stored
  for (const planned of plan.steps) {
    const kind = stepKindOf(planned.step)
    if (kind.phase === 0) keyed = kind.apply(planned.step, keyed, code)
  }
  const valued = new Set(
    plan.steps.flatMap((planned) =>
      stepKindOf(planned.step).stagesValues && "propertyId" in planned.step
        ? [planned.step.propertyId]
        : []
    )
  )
  const valueChanges = diffTypeShapes(keyed, code).filter(
    (change) =>
      change.effect !== "compatible" &&
      "propertyId" in change &&
      valued.has(change.propertyId) &&
      !covered.some((held) => sameConcern(held, change))
  )

  return {
    conflicts: plan.conflicts.map((conflict) => ({
      change: changeOf(changes, conflict.steps[1].step),
      message: conflict.message,
    })),
    missing,
    covered,
    valueChanges,
    steps: plan.steps,
    stepsFor: (change) => coveringSteps(plan, change),
    storedKey: plan.storedKey,
    remedy(change) {
      if (covered.some((held) => held === change) || valueChanges.includes(change)) {
        const migrationIds = coveringSteps(plan, change).map((planned) => planned.migrationId)
        return [pendingMigrationLine([...new Set(migrationIds)])]
      }

      return [
        ...blockedLines(plan, change),
        ...missingMigrationLines(objectTypeId, change, ontology, takenIds),
      ]
    },
  }
}

/**
 * Whether two changes are about the same thing: one property or link, and what the data must do
 * about it. A property added as required and one made required both ask for a value.
 */
function sameConcern(left: TypeShapeChange, right: TypeShapeChange): boolean {
  return concernOf(left) === concernOf(right)
}

function concernOf(change: TypeShapeChange): string {
  const kind = change.kind === "property-added" ? "property-required" : change.kind
  if ("propertyId" in change) return `${kind}:${change.propertyId}`
  if ("linkId" in change) return `${kind}:${change.linkId}`
  return kind
}

/** A change of a subject the step holds. A pending step always has one: it resolves a change. */
function changeOf<TChange extends TypeShapeChange>(
  changes: readonly TChange[],
  step: OntologyMigrationStep
): TChange {
  const change = changes.find((candidate) => mentions(step, candidate))
  if (!change) throw new Error(`[Sixb] A pending migration step resolves no change of its type.`)
  return change
}

/**
 * The pending steps that resolve the change: those of the kind that resolves it, or else any that
 * moves its key, as a rename into a new required property does.
 */
function coveringSteps(plan: PendingSteps, change: TypeShapeChange): readonly PlannedStep[] {
  const touching = plan.steps.filter((planned) => mentions(planned.step, change))
  const resolving = touching.filter((planned) => stepKindOf(planned.step).suggest(change))
  return resolving.length > 0 ? resolving : touching
}

/** Why a step that would resolve the change can't run on the stored shape. */
function blockedLines(plan: PendingSteps, change: TypeShapeChange): string[] {
  return plan.blocked
    .filter((blocked) => mentions(blocked.step, change))
    .map(
      (blocked) =>
        `Migration '${blocked.migrationId}' ${stepKindOf(blocked.step).describe(blocked.step)}, ` +
        `which can't run: ${blocked.reason}`
    )
}

/** Whether the step holds the change's property or link. */
function mentions(step: OntologyMigrationStep, change: TypeShapeChange): boolean {
  return stepKindOf(step)
    .subjects(step)
    .some((subject) =>
      subject.role === "link"
        ? "linkId" in change && change.linkId === subject.id
        : "propertyId" in change && change.propertyId === subject.id
    )
}
