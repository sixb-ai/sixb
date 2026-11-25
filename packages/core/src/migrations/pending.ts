import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { type TypeShape, typeShape } from "../ontology/type-shapes"
import { stepKindOf, subjectKey } from "./steps"
import { sameJson } from "./steps/kind"
import type { MigrationDefinition, OntologyMigrationStep } from "./types"

/** One step of one migration, as it applies to a concrete type. */
export interface PlannedStep {
  readonly migrationId: string
  /** The step's position in its migration's chain. */
  readonly index: number
  readonly step: OntologyMigrationStep
}

/** A step that would resolve a change, and why the stored shape keeps it from running. */
export interface BlockedStep extends PlannedStep {
  readonly reason: string
}

/** Two pending steps that can't both run: the gate refuses the type for them. */
export interface StepConflict {
  /** One sentence naming both migrations and what each does. */
  readonly message: string
  readonly steps: readonly [PlannedStep, PlannedStep]
}

export interface PendingSteps {
  /** The steps the stored shape still needs, in the order they run. */
  readonly steps: readonly PlannedStep[]
  /** What the stored objects fit once they have run: the code's shape, but for what isn't covered. */
  readonly shape: TypeShape
  /** Steps that never ran, with the reason; the gate names those that leave data behind. */
  readonly blocked: readonly BlockedStep[]
  readonly conflicts: readonly StepConflict[]
  /** The key a property of the code has in the stored objects, through the renames that run. */
  storedKey(propertyId: string): string
}

/**
 * Which steps of `migrations` the stored objects of one concrete type still need. A step is pending
 * exactly while its condition holds against the shape: steps run in the order those conditions
 * allow, so a rename into `b` runs before a convert of `b`, and a migration every step of which is
 * already satisfied never runs. No ledger, no order of files: two branches migrating different
 * properties compose.
 *
 * A migration of a type applies to each subtype that inherits what its steps touch. A migration
 * runs at most once per database: once `settled` there, it is never pending again, even when its
 * conditions hold anew, as an old convert's would after a second narrowing of its property.
 */
export function planPendingSteps(input: {
  readonly objectTypeId: string
  /** The shape the stored objects fit: the recorded one, or the first deploy's baseline. */
  readonly stored: TypeShape
  readonly ontology: OntologyDefinitionCatalog
  readonly migrations: readonly MigrationDefinition[]
  /** Migrations this database already ran, or recorded a shape past without needing. */
  readonly settled?: ReadonlySet<string>
}): PendingSteps {
  const { objectTypeId, stored, ontology } = input
  const settled = input.settled ?? new Set<string>()
  const migrations = input.migrations.filter((migration) => !settled.has(migration.id))

  const code = typeShape(ontology.resolveObjectType(objectTypeId), ontology)
  const candidates = candidateSteps(objectTypeId, code, ontology, migrations)

  let shape = stored
  const ordered: PlannedStep[] = []
  const conflicts: StepConflict[] = []
  const remaining = new Set(candidates)

  // Each round runs the first pending step, until none is pending: by phase (renames, values,
  // removals), then by (migration id, index). A step runs at most once, so the loop ends.
  while (remaining.size > 0) {
    const pending = [...remaining].filter((planned) =>
      stepKindOf(planned.step).pending(planned.step, shape, code)
    )
    if (pending.length === 0) break

    conflicts.push(...conflictsAmong(objectTypeId, pending))
    if (conflicts.length > 0) break

    const phase = Math.min(...pending.map((planned) => stepKindOf(planned.step).phase))
    const next = pending.find((planned) => stepKindOf(planned.step).phase === phase)!
    shape = stepKindOf(next.step).apply(next.step, shape, code)
    ordered.push(next)
    remaining.delete(next)

    // An identical step of another migration is satisfied by this one.
    for (const planned of pending) {
      if (planned !== next && sameKeyStep(planned.step, next.step)) remaining.delete(planned)
    }
  }

  const blocked: BlockedStep[] = []
  for (const planned of remaining) {
    const reason = stepKindOf(planned.step).blocked(planned.step, shape, objectTypeId)
    if (reason) blocked.push({ ...planned, reason })
  }

  return {
    steps: ordered,
    shape,
    blocked,
    conflicts,
    storedKey(propertyId) {
      let key = propertyId
      for (const planned of [...ordered].reverse()) {
        key = stepKindOf(planned.step).storedKey?.(planned.step, key) ?? key
      }
      return key
    },
  }
}

/**
 * The steps of every migration of the type or of one of its ancestors that concern it, by
 * (migration id, index). Only the `extends` chain counts: it is what properties are inherited by.
 */
function candidateSteps(
  objectTypeId: string,
  code: TypeShape,
  ontology: OntologyDefinitionCatalog,
  migrations: readonly MigrationDefinition[]
): PlannedStep[] {
  const concrete = ontology.resolveObjectType(objectTypeId)
  const declaring = new Map(
    ontology
      .listAncestorChain(concrete)
      .map((type) => [type.id, type.id === objectTypeId ? code : typeShape(type, ontology)])
  )

  const candidates: PlannedStep[] = []
  for (const migration of [...migrations].sort(byId)) {
    const declaringShape = declaring.get(migration.objectTypeId)
    if (!declaringShape) continue

    migration.steps.forEach((step, index) => {
      if (stepKindOf(step).appliesTo(step, code, declaringShape)) {
        candidates.push({ migrationId: migration.id, index, step })
      }
    })
  }

  return candidates
}

/** Two pending steps that hold one key, unless they do exactly the same key move. */
function conflictsAmong(objectTypeId: string, pending: readonly PlannedStep[]): StepConflict[] {
  const holders = new Map<string, PlannedStep>()
  const conflicts: StepConflict[] = []

  for (const planned of pending) {
    for (const subject of stepKindOf(planned.step).subjects(planned.step)) {
      const key = subjectKey(subject)
      const holder = holders.get(key)
      if (!holder) {
        holders.set(key, planned)
        continue
      }
      if (sameKeyStep(holder.step, planned.step)) continue

      // A step is named once, whatever keys it shares.
      conflicts.push({
        message:
          `${objectTypeId}: migration '${holder.migrationId}' ${describe(holder.step)}, and ` +
          `migration '${planned.migrationId}' ${describe(planned.step)}: only one can run.`,
        steps: [holder, planned],
      })
      break
    }
  }

  return conflicts
}

/** Fill and convert never count as the same: their functions differ. */
function sameKeyStep(left: OntologyMigrationStep, right: OntologyMigrationStep): boolean {
  return !stepKindOf(left).stagesValues && sameJson(left, right)
}

function describe(step: OntologyMigrationStep): string {
  return stepKindOf(step).describe(step)
}

function byId(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
