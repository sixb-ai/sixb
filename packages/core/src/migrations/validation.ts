import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { typeShape } from "../ontology/type-shapes"
import { snapshotMigrationDefinition } from "./builders"
import { stepKindOf, subjectKey } from "./steps"
import type { MigrationDefinition, OntologyMigrationStep } from "./types"

/**
 * Refuses, when the host loads, a migration that can never be right: a duplicate id, no step, a
 * rename into itself, a value given to a primary or telemetry property, or one subject changed
 * twice. A migration the code has moved past is not an error: {@link inertMigrations} names it.
 */
export function validateMigrationsAtStartup(input: {
  readonly migrations: readonly MigrationDefinition[]
  readonly ontology: OntologyDefinitionCatalog
}): ReadonlyMap<string, MigrationDefinition> {
  const byId = new Map<string, MigrationDefinition>()

  for (const authored of input.migrations) {
    const migration = snapshotMigrationDefinition(authored)
    if (byId.has(migration.id)) {
      throw invalid(`Two migrations have the id '${migration.id}': give each its own.`)
    }

    const objectType = input.ontology.getObjectTypeById(migration.objectTypeId)
    const shape = objectType ? typeShape(objectType, input.ontology) : null
    const holders = new Map<string, OntologyMigrationStep>()

    for (const step of migration.steps) {
      const kind = stepKindOf(step)
      const reason = shape ? kind.refused(step, shape, migration.objectTypeId) : null
      if (reason) throw invalid(`Migration '${migration.id}' ${reason}`)

      for (const subject of kind.subjects(step)) {
        const key = subjectKey(subject)
        const holder = holders.get(key)
        if (holder) throw invalid(twice(migration.id, holder, step))
        holders.set(key, step)
      }
    }

    byId.set(migration.id, migration)
  }

  return byId
}

/**
 * The migrations the code has moved past: their type is gone, or every step names what the type
 * declares again or no longer declares. They can never be pending again, so they do nothing;
 * `sixb check` says they can be deleted. Roles never refuse to start over them.
 */
export function inertMigrations(input: {
  readonly migrations: readonly MigrationDefinition[]
  readonly ontology: OntologyDefinitionCatalog
}): string[] {
  const lines: string[] = []

  for (const migration of input.migrations) {
    const objectType = input.ontology.getObjectTypeById(migration.objectTypeId)
    if (!objectType) {
      lines.push(deletable(migration.id, `is for '${migration.objectTypeId}', no longer defined`))
      continue
    }

    const shape = typeShape(objectType, input.ontology)
    const reasons = migration.steps.flatMap(
      (step) => stepKindOf(step).inert(step, shape, objectType.id) ?? []
    )
    if (reasons.length === migration.steps.length) {
      lines.push(deletable(migration.id, reasons.join(", and ")))
    }
  }

  return lines
}

function deletable(migrationId: string, reason: string): string {
  return (
    `Migration '${migrationId}' ${reason}: it does nothing now, and can be deleted once every ` +
    "database has applied it."
  )
}

function twice(
  migrationId: string,
  first: OntologyMigrationStep,
  second: OntologyMigrationStep
): string {
  const before = stepKindOf(first).describe(first)
  const after = stepKindOf(second).describe(second)
  if (before === after) return `Migration '${migrationId}' ${after} twice: keep one step.`

  return `Migration '${migrationId}' ${before} and ${after}: a property changes once per migration.`
}

function invalid(message: string): Error {
  return new Error(`[Sixb] ${message}`)
}
