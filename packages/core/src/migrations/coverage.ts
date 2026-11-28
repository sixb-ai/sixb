import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { diffTypeShapes, type TypeShape, type TypeShapeChange } from "../ontology/type-shapes"
import { missingMigrationLines, pendingMigrationLine } from "./messages"
import { type PendingSteps, planPendingSteps } from "./pending"
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

  return {
    conflicts: plan.conflicts.map((conflict) => ({
      change: changeOf(changes, conflict.steps[1].step),
      message: conflict.message,
    })),
    missing,
    covered,
    storedKey: plan.storedKey,
    remedy(change) {
      if (covered.some((held) => held === change)) {
        return [pendingMigrationLine(coveringMigrations(plan, change))]
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
 * The migrations whose pending steps resolve the change: those of the kind that resolves it, or
 * else any that moves its key, as a rename into a new required property does.
 */
function coveringMigrations(plan: PendingSteps, change: TypeShapeChange): string[] {
  const touching = plan.steps.filter((planned) => mentions(planned.step, change))
  const resolving = touching.filter((planned) => stepKindOf(planned.step).suggest(change))
  const steps = resolving.length > 0 ? resolving : touching

  return [...new Set(steps.map((planned) => planned.migrationId))]
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
