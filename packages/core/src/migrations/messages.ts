import type { OntologyDefinitionCatalog } from "../ontology/registry"
import { type TypeShape, type TypeShapeChange, typeShape } from "../ontology/type-shapes"
import { stepKinds } from "./steps"
import { hasLink, hasProperty, quoted, sameProperty } from "./steps/kind"

/**
 * The lines `sixb check` writes under a change no migration covers: the steps that would, as code
 * to paste. Empty for a change no step resolves. The agent reads the same lines.
 *
 * ```text
 * Rename or remove it in a migration:
 *   defineMigration("job-gate", Job).renameProperty("gate", "<new id>")
 *   defineMigration("job-gate", Job).removeProperty("gate")
 * ```
 */
export function missingMigrationLines(
  objectTypeId: string,
  change: TypeShapeChange,
  ontology: OntologyDefinitionCatalog,
  /** The ids of the project's migrations: the suggested one is new. */
  takenIds: ReadonlySet<string>
): string[] {
  const suggestions = Object.values(stepKinds).flatMap((kind) => kind.suggest(change) ?? [])
  if (suggestions.length === 0 || !("propertyId" in change || "linkId" in change)) return []

  const subject = "propertyId" in change ? change.propertyId : change.linkId
  const type = migrationTypeFor(objectTypeId, change, ontology)
  const migrationId = unusedId(migrationIdFor(type, subject), takenIds)
  const definition = `defineMigration(${quoted(migrationId)}, ${identifierFor(type)})`

  const verbs = suggestions.map((suggestion) => suggestion.verb).join(" or ")
  const them = change.kind === "property-retyped" || change.kind === "property-not-nullable"

  return [
    `${capitalize(verbs)} ${them ? "them" : "it"} in a migration:`,
    ...suggestions.map((suggestion) => `  ${definition}.${suggestion.call}`),
  ]
}

/** What a change covered by migrations says, while this build can't run them. */
export function pendingMigrationLine(migrationIds: readonly string[]): string {
  const names = migrationIds.map((id) => `'${id}'`).join(" and ")
  return migrationIds.length === 1
    ? `Migration ${names} is pending; this build can't apply it yet.`
    : `Migrations ${names} are pending; this build can't apply them yet.`
}

/** What two pending steps that can't both run say, after the sentence that names them. */
export const CONFLICT_REMEDY = "Keep one. A migration every database has applied can be deleted."

/**
 * The type the suggested migration names: the highest ancestor the change holds for too, so one
 * migration covers every subtype that inherits it.
 */
function migrationTypeFor(
  objectTypeId: string,
  change: TypeShapeChange,
  ontology: OntologyDefinitionCatalog
): string {
  const concrete = ontology.getObjectTypeById(objectTypeId)
  if (!concrete) return objectTypeId

  const code = typeShape(concrete, ontology)
  const holds = (shape: TypeShape): boolean => {
    if (change.kind === "property-removed") return !hasProperty(shape, change.propertyId)
    if (change.kind === "link-removed") return !hasLink(shape, change.linkId)
    return "propertyId" in change && sameProperty(shape, code, change.propertyId)
  }

  const ancestor = ontology
    .listAncestorChain(concrete)
    .find((type) => holds(type.id === objectTypeId ? code : typeShape(type, ontology)))
  return ancestor?.id ?? objectTypeId
}

/** `"job-gate"` for `gate` on `Job`. */
function migrationIdFor(objectTypeId: string, subject: string): string {
  return `${kebab(localName(objectTypeId))}-${kebab(subject)}`
}

/** `job-gate`, or `job-gate-2` when a migration already has that id. */
function unusedId(id: string, takenIds: ReadonlySet<string>): string {
  let candidate = id
  for (let suffix = 2; takenIds.has(candidate); suffix += 1) candidate = `${id}-${suffix}`
  return candidate
}

/** What the code most likely calls the type: its id without a namespace, as an identifier. */
function identifierFor(objectTypeId: string): string {
  const identifier = localName(objectTypeId).replace(/[^A-Za-z0-9_$]/g, "")
  return /^[A-Za-z_$]/.test(identifier) ? identifier : `_${identifier}`
}

function localName(objectTypeId: string): string {
  return objectTypeId.slice(objectTypeId.lastIndexOf(":") + 1)
}

function kebab(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
