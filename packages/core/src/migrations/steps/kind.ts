import { stableJsonStringify } from "../../json"
import type { PropertyShape, TypeShape, TypeShapeChange } from "../../ontology/type-shapes"
import type { OntologyMigrationStoreStep } from "../../storage/ontology/migrations"
import type { OntologyMigrationStep } from "../types"

/**
 * What one kind of step means against shapes. The pending algorithm (`pending.ts`), startup
 * validation and the gate's messages only call these, so a new kind is one file and one registry
 * entry. Everything here is pure: no storage, no data.
 */
export interface StepKind<S extends OntologyMigrationStep> {
  /**
   * When the step runs among a type's pending steps: renames (0), then values (1), then removals
   * (2), so a fill can read a key its migration removes afterwards.
   */
  readonly phase: 0 | 1 | 2

  /** Fill and convert give values: two pending on one property conflict, whatever they do. */
  readonly stagesValues?: true

  /** What the step does, to end "migration 'job-gate' …": `removes 'gate'`. */
  describe(step: S): string

  /** Why the step can never be right on the migration's own type, or `null`. Refused at load. */
  refused(step: S, type: TypeShape, typeName: string): string | null

  /**
   * Why the code has moved past the step, so it can never be pending again, or `null`: a removed
   * id declared again, a rename into a property no longer declared. Only a warning.
   */
  inert(step: S, type: TypeShape, typeName: string): string | null

  /**
   * Whether the step concerns `concrete`: the migration's type itself, `declaring`, or a subtype.
   * A subtype that declares again what the step reads is left out.
   */
  appliesTo(step: S, concrete: TypeShape, declaring: TypeShape): boolean

  /** What the step holds: no two pending steps may hold the same subject. */
  subjects(step: S): readonly StepSubject[]

  /** Whether `stored` still needs the step to fit `code`. */
  pending(step: S, stored: TypeShape, code: TypeShape): boolean

  /** The shape the stored objects fit once the step has run. */
  apply(step: S, stored: TypeShape, code: TypeShape): TypeShape

  /** Why a step that would resolve a change can't run on `stored`, or `null`. */
  blocked(step: S, stored: TypeShape, typeName: string): string | null

  /** The key the code's `propertyId` had before the step: a rename's `from` for its `to`. */
  storedKey?(step: S, propertyId: string): string | undefined

  /** The call `sixb check` writes for a change this kind of step resolves, or `null`. */
  suggest(change: TypeShapeChange): StepSuggestion | null

  /** The step as storage applies it. */
  storeStep(step: S, context: StoreStepContext): OntologyMigrationStoreStep
}

/** What storage needs to know of the stored data to apply a step, read when the run is planned. */
export interface StoreStepContext {
  /** The renamed-from ids of the type whose unique values move to the new id. */
  readonly uniqueMoves: ReadonlySet<string>
  /** The unique properties value steps give values to, and how their stored values follow. */
  readonly valueUnique: ReadonlyMap<string, "update" | "rebuild">
}

/**
 * A property or link a step holds, and in what role. A rename holds its `from` like a removal
 * does and its `to` on its own: two renames into one property conflict, a removal of it doesn't.
 * One fill and one convert of a property may be pending together.
 */
export interface StepSubject {
  readonly role: "property" | "renamedTo" | "fill" | "convert" | "link"
  readonly id: string
}

export interface StepSuggestion {
  /** How the line before the calls names it: "Rename or remove it in a migration:". */
  readonly verb: string
  /** The chained call, without the leading dot. */
  readonly call: string
}

export function withProperty(shape: TypeShape, id: string, property: PropertyShape): TypeShape {
  return { ...shape, properties: sortKeys({ ...shape.properties, [id]: property }) }
}

export function withoutProperty(shape: TypeShape, id: string): TypeShape {
  const { [id]: _removed, ...properties } = shape.properties
  return { ...shape, properties }
}

export function hasProperty(shape: TypeShape, id: string): boolean {
  return Object.hasOwn(shape.properties, id)
}

export function hasLink(shape: TypeShape, id: string): boolean {
  return Object.hasOwn(shape.links, id)
}

/** The same property in both shapes: inherited unchanged, or declared again identically. */
export function sameProperty(left: TypeShape, right: TypeShape, id: string): boolean {
  const property = left.properties[id]
  return property !== undefined && sameJson(property, right.properties[id])
}

/** A property no value can be given to: the primary property, or a telemetry series. */
export function valueTargetRefused(
  verb: string,
  id: string,
  type: TypeShape,
  typeName: string
): string | null {
  const property = type.properties[id]
  if (!property) return null
  if (property.primary) {
    return `${verb} '${id}', the primary property of ${typeName}: changing it isn't supported yet.`
  }
  if (property.mode === "telemetry") {
    return `${verb} '${id}', a telemetry property: migrating telemetry isn't supported yet.`
  }

  return null
}

export function quoted(value: string): string {
  return JSON.stringify(value)
}

export function sameJson(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

function sortKeys<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, record[key]!])
  )
}
