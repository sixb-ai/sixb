import type { ObjectTypeWithPropertyTokens } from "../ontology/tokens"
import type {
  ConvertPropertyInput,
  FillPropertyInput,
  MigrationBuilder,
  MigrationDefinition,
  OntologyMigrationStep,
} from "./types"

/**
 * Declares how the stored objects of `objectType` follow a change of its definition. Each step
 * runs only while the stored shape still needs it, so a migration a database already went through
 * never runs again there.
 *
 * ```ts
 * export const jobGateCode = defineMigration("job-gate-code", Job)
 *   .renameProperty("gate", "gateCode")
 *   .removeProperty("legacyNote")
 * ```
 */
export function defineMigration<
  const TId extends string,
  const T extends ObjectTypeWithPropertyTokens,
>(id: TId, objectType: T): MigrationBuilder<TId, T> {
  assertNonEmpty(id, "Migration id")
  if (!isRecord(objectType) || !isNonEmpty(objectType.id)) {
    throw invalid(`Migration '${id}' needs an object type.`)
  }

  return createBuilder(id, objectType.id, [])
}

export function isMigrationDefinition(value: unknown): value is MigrationDefinition {
  return (
    isRecord(value) &&
    value.kind === "migration" &&
    isNonEmpty(value.id) &&
    isNonEmpty(value.objectTypeId) &&
    Array.isArray(value.steps)
  )
}

/** @internal Validates a definition's own data and detaches it from its builder. */
export function snapshotMigrationDefinition(value: unknown): MigrationDefinition {
  if (!isMigrationDefinition(value)) {
    throw invalid("A migration must be made with defineMigration().")
  }

  const steps = value.steps.map((step) => snapshotStep(value.id, step))
  if (steps.length === 0) {
    throw invalid(`Migration '${value.id}' has no steps: add at least one.`)
  }

  return Object.freeze({
    kind: "migration" as const,
    id: value.id,
    objectTypeId: value.objectTypeId,
    steps: Object.freeze(steps),
  })
}

// The chain methods live on one prototype, so a definition's own keys are its data alone.
const builderPrototype = {
  removeProperty(this: MigrationDefinition, propertyId: string) {
    return addStep(this, { kind: "removeProperty", propertyId })
  },
  removeLink(this: MigrationDefinition, linkId: string) {
    return addStep(this, { kind: "removeLink", linkId })
  },
  renameProperty(this: MigrationDefinition, from: string, to: string) {
    return addStep(this, { kind: "renameProperty", from, to })
  },
  fillProperty(this: MigrationDefinition, propertyId: string, fill: () => unknown) {
    return addStep(this, { kind: "fillProperty", propertyId, fill })
  },
  convertProperty(this: MigrationDefinition, propertyId: string, convert: () => unknown) {
    return addStep(this, { kind: "convertProperty", propertyId, convert })
  },
}

function addStep(definition: MigrationDefinition, step: OntologyMigrationStep) {
  const checked = snapshotStep(definition.id, step)
  return createBuilder(definition.id, definition.objectTypeId, [...definition.steps, checked])
}

function createBuilder<TId extends string, T extends ObjectTypeWithPropertyTokens>(
  id: TId,
  objectTypeId: string,
  steps: readonly OntologyMigrationStep[]
): MigrationBuilder<TId, T> {
  const definition = Object.assign(Object.create(builderPrototype), {
    kind: "migration",
    id,
    objectTypeId,
    steps: Object.freeze(steps),
  })

  // The prototype's methods match the builder's signatures; their parameter types are only wider.
  return Object.freeze(definition) as MigrationBuilder<TId, T>
}

function snapshotStep(migrationId: string, value: unknown): OntologyMigrationStep {
  if (!isRecord(value)) throw invalid(`Migration '${migrationId}' has a step that isn't one.`)
  const where = `Migration '${migrationId}', ${String(value.kind)}`

  switch (value.kind) {
    case "removeProperty":
      return Object.freeze({ kind: value.kind, propertyId: stepId(value.propertyId, where) })
    case "removeLink":
      return Object.freeze({ kind: value.kind, linkId: stepId(value.linkId, where) })
    case "renameProperty":
      return Object.freeze({
        kind: value.kind,
        from: stepId(value.from, where),
        to: stepId(value.to, where),
      })
    case "fillProperty":
      return Object.freeze({
        kind: value.kind,
        propertyId: stepId(value.propertyId, where),
        fill: stepFunction<(input: FillPropertyInput) => unknown>(value.fill, where),
      })
    case "convertProperty":
      return Object.freeze({
        kind: value.kind,
        propertyId: stepId(value.propertyId, where),
        convert: stepFunction<(input: ConvertPropertyInput) => unknown>(value.convert, where),
      })
    default:
      throw invalid(
        `Migration '${migrationId}' has a step of unknown kind '${String(value.kind)}'.`
      )
  }
}

function stepId(value: unknown, where: string): string {
  if (!isNonEmpty(value)) throw invalid(`${where}: ids must be non-empty strings.`)
  return value
}

/** A function's parameters can't be checked at runtime: the builder's signature typed them. */
function stepFunction<TFunction>(value: unknown, where: string): TFunction {
  if (typeof value !== "function") throw invalid(`${where}: the value function is missing.`)
  return value as TFunction
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (!isNonEmpty(value)) throw invalid(`${field} must be a non-empty string.`)
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function invalid(message: string): Error {
  return new Error(`[Sixb] ${message}`)
}
