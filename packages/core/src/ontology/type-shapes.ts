import { stableJsonStringify } from "../json"
import { linkTargetObjectTypeIds } from "./link-targets"
import { primitiveTraits } from "./primitives"
import type { OntologyDefinitionCatalog } from "./registry"
import type { ObjectLink, ObjectType, PrimitiveSchema, Property, Schema, ValueType } from "./types"

/**
 * What the values of a property may be, as stored objects fit it: value types written in place,
 * without names or descriptions. `"unknown"` accepts any value: a key the data holds that no
 * definition declares, or values that fit no declared schema. `{ valueType }` stands for a value
 * type that refers to itself, compared by id.
 */
export type SchemaShape =
  | PrimitiveSchema
  | "unknown"
  | { readonly type: "enum"; readonly valueType: "string"; readonly values: readonly string[] }
  | { readonly type: "enum"; readonly valueType: "integer"; readonly values: readonly number[] }
  | { readonly type: "array"; readonly items: SchemaShape }
  | { readonly type: "map"; readonly keySchema: "string"; readonly valueSchema: SchemaShape }
  | { readonly type: "object"; readonly properties: Readonly<Record<string, FieldShape>> }
  | { readonly valueType: string }

export interface FieldShape {
  readonly schema: SchemaShape
  readonly required?: true
  readonly nullable?: true
}

/** A flag is written only when set: `required: false` and `mode: "static"` are the defaults. */
export interface PropertyShape extends FieldShape {
  readonly mode?: "telemetry"
  readonly unique?: true
  readonly primary?: true
  /** A key the stored data holds that no definition declared when the shape was recorded. */
  readonly unknown?: true
}

/** A link's targets and cardinality. Its properties are not part of the shape in V1. */
export interface LinkShape {
  /** Every type the link accepts, subtypes included, or `["*"]` for a link to any type. */
  readonly targets: readonly string[]
  readonly cardinality: "one" | "many"
  /** Links the stored data holds that no definition declared: their targets are unknown. */
  readonly unknown?: true
}

/** The shape of one concrete object type: its own and its inherited properties and links. */
export interface TypeShape {
  readonly properties: Readonly<Record<string, PropertyShape>>
  readonly links: Readonly<Record<string, LinkShape>>
}

/**
 * - `compatible`: every stored value still fits, so nothing needs to be read.
 * - `narrowing`: stored data may no longer fit; a probe decides, and a migration moves it.
 * - `refused`: V1 can't migrate this change; it is accepted only when no data holds it.
 */
export type TypeShapeEffect = "compatible" | "narrowing" | "refused"

export type TypeShapeChange =
  | { readonly kind: "type-removed"; readonly effect: "refused" }
  | {
      readonly kind: "primary"
      readonly from: string
      readonly to: string
      readonly effect: "refused"
    }
  | PropertyChange
  | LinkChange

type PropertyChange = { readonly propertyId: string; readonly effect: TypeShapeEffect } & (
  | { readonly kind: "property-added" }
  | { readonly kind: "property-removed" }
  | { readonly kind: "property-required" }
  | { readonly kind: "property-optional" }
  | { readonly kind: "property-nullable" }
  | { readonly kind: "property-not-nullable" }
  | { readonly kind: "property-retyped"; readonly from: SchemaShape; readonly to: SchemaShape }
  | { readonly kind: "property-mode"; readonly to: "static" | "telemetry" }
  | { readonly kind: "property-unique"; readonly unique: boolean }
)

type LinkChange = { readonly linkId: string; readonly effect: TypeShapeEffect } & (
  | { readonly kind: "link-added" }
  | { readonly kind: "link-removed" }
  | {
      readonly kind: "link-targets"
      readonly from: readonly string[]
      readonly to: readonly string[]
    }
  | { readonly kind: "link-cardinality"; readonly to: "one" | "many" }
)

/** The shape of `objectType` as the code defines it, with sorted keys so it serializes the same. */
export function typeShape(objectType: ObjectType, ontology: OntologyDefinitionCatalog): TypeShape {
  const valueTypes = ontology.getValueTypesById()
  const primaryId = ontology.getPrimaryPropertyId(objectType.id)

  const properties: Record<string, PropertyShape> = {}
  for (const property of sortById(objectType.properties)) {
    properties[property.id] = propertyShape(property, valueTypes, property.id === primaryId)
  }

  const links: Record<string, LinkShape> = {}
  for (const link of sortById(objectType.links)) {
    links[link.id] = linkShape(link, ontology)
  }

  return { properties, links }
}

/** The primary property of a shape, or `undefined` for a shape recorded without one. */
export function shapePrimaryId(shape: TypeShape): string | undefined {
  return Object.keys(shape.properties).find((id) => shape.properties[id]!.primary)
}

/**
 * `stored` without the link targets the code no longer defines as object types. Each is a type
 * removed, whose own `type-removed` change probes its objects: links to it don't retarget the link.
 */
export function withoutRemovedTargets(
  stored: TypeShape,
  ontology: Pick<OntologyDefinitionCatalog, "getObjectTypeById">
): TypeShape {
  const links: Record<string, LinkShape> = {}
  for (const [linkId, link] of Object.entries(stored.links)) {
    const targets = link.targets.filter(
      (target) => target === "*" || ontology.getObjectTypeById(target) !== null
    )
    links[linkId] = targets.length === link.targets.length ? link : { ...link, targets }
  }

  return { ...stored, links }
}

/**
 * What changed from the shape the stored objects fit to the code's, property by property. `null`
 * code means the type is no longer defined. Changes come in a stable order: the primary property,
 * then properties and links by id.
 */
export function diffTypeShapes(stored: TypeShape, code: TypeShape | null): TypeShapeChange[] {
  if (!code) return [{ kind: "type-removed", effect: "refused" }]

  const changes: TypeShapeChange[] = []

  // A changed primary property is one change: the old one's removal and the new one's addition
  // are what changing it means, not two more things to migrate.
  const storedPrimary = shapePrimaryId(stored)
  const codePrimary = shapePrimaryId(code)
  const primaryChanged = storedPrimary !== undefined && storedPrimary !== codePrimary
  if (primaryChanged) {
    changes.push({ kind: "primary", from: storedPrimary, to: codePrimary ?? "", effect: "refused" })
  }

  for (const propertyId of unionOfKeys(stored.properties, code.properties)) {
    if (primaryChanged && (propertyId === storedPrimary || propertyId === codePrimary)) continue
    changes.push(
      ...diffProperty(propertyId, stored.properties[propertyId], code.properties[propertyId])
    )
  }

  for (const linkId of unionOfKeys(stored.links, code.links)) {
    changes.push(...diffLink(linkId, stored.links[linkId], code.links[linkId]))
  }

  return changes
}

/** Whether every value `from` accepts, `to` accepts too. */
export function schemaWidens(from: SchemaShape, to: SchemaShape): boolean {
  if (sameShape(from, to)) return true
  if (from === "unknown") return false

  if (typeof from === "string") {
    return typeof to === "string" && (PRIMITIVE_WIDENINGS[from] ?? []).includes(to)
  }

  // A value type that refers to itself compares by id, and that already failed above.
  if (!("type" in from)) return false
  if (from.type === "enum" && typeof to === "string") return enumWidensTo(from.valueType, to)
  if (typeof to === "string" || !("type" in to)) return false

  switch (from.type) {
    case "enum":
      return (
        to.type === "enum" &&
        to.valueType === from.valueType &&
        (from.values as readonly (string | number)[]).every((value) =>
          (to.values as readonly (string | number)[]).includes(value)
        )
      )
    case "array":
      return to.type === "array" && schemaWidens(from.items, to.items)
    case "map":
      return to.type === "map" && schemaWidens(from.valueSchema, to.valueSchema)
    case "object":
      return to.type === "object" && fieldsWiden(from.properties, to.properties)
  }
}

/**
 * The primitives whose values another primitive's validator also accepts. A uuid is a string; an
 * integer is a finite number. A decimal is a string of digits, so no number widens to it.
 */
const PRIMITIVE_WIDENINGS: Partial<Record<PrimitiveSchema, readonly SchemaShape[]>> = {
  integer: ["double"],
  uuid: ["string"],
}

function enumWidensTo(valueType: "string" | "integer", to: SchemaShape): boolean {
  if (valueType === "string") return to === "string"
  return to === "integer" || to === "double"
}

/** Every stored field stays declared and accepts its values; no new field is required. */
function fieldsWiden(
  from: Readonly<Record<string, FieldShape>>,
  to: Readonly<Record<string, FieldShape>>
): boolean {
  for (const [fieldId, field] of Object.entries(from)) {
    const next = to[fieldId]
    if (!next || !fieldWidens(field, next)) return false
  }

  return Object.keys(to).every((fieldId) => fieldId in from || !to[fieldId]!.required)
}

function fieldWidens(from: FieldShape, to: FieldShape): boolean {
  if (to.required && !from.required) return false
  if (from.nullable && !to.nullable) return false

  return schemaWidens(from.schema, to.schema)
}

function diffProperty(
  propertyId: string,
  stored: PropertyShape | undefined,
  code: PropertyShape | undefined
): TypeShapeChange[] {
  if (!stored) {
    // A telemetry property's latest point is never required of an object.
    const required = code!.required === true && code!.mode !== "telemetry"
    return [{ kind: "property-added", propertyId, effect: required ? "narrowing" : "compatible" }]
  }

  if (!code) {
    // Series can be huge: V1 never rewrites telemetry.
    const effect = stored.mode === "telemetry" ? "refused" : "narrowing"
    return [{ kind: "property-removed", propertyId, effect }]
  }

  // A static value and a series are stored apart: nothing compares across them.
  if ((stored.mode ?? "static") !== (code.mode ?? "static")) {
    return [{ kind: "property-mode", propertyId, to: code.mode ?? "static", effect: "refused" }]
  }

  const telemetry = code.mode === "telemetry"
  const changes: TypeShapeChange[] = []

  if (!telemetry && code.required !== stored.required) {
    changes.push(
      code.required
        ? { kind: "property-required", propertyId, effect: "narrowing" }
        : { kind: "property-optional", propertyId, effect: "compatible" }
    )
  }

  if (code.nullable !== stored.nullable) {
    const narrowing = telemetry ? "refused" : "narrowing"
    changes.push(
      code.nullable
        ? { kind: "property-nullable", propertyId, effect: "compatible" }
        : { kind: "property-not-nullable", propertyId, effect: narrowing }
    )
  }

  if (!sameShape(stored.schema, code.schema)) {
    const narrowing = telemetry ? "refused" : "narrowing"
    const effect = schemaWidens(stored.schema, code.schema) ? "compatible" : narrowing
    changes.push({
      kind: "property-retyped",
      propertyId,
      from: stored.schema,
      to: code.schema,
      effect,
    })
  }

  // A property made unique, or whose values compare another way, narrows what the data may hold:
  // two objects may share a value, and the old release may still write one. Unique preparation's
  // dry run reads the data for it. Dropping `unique` widens.
  const rekeyed =
    code.unique === true &&
    stored.unique === true &&
    !sameShape(stored.schema, code.schema) &&
    (uniqueKeyKind(stored.schema) ?? "unknown") !== (uniqueKeyKind(code.schema) ?? "other")
  if (code.unique !== stored.unique || rekeyed) {
    const unique = code.unique === true
    const effect = unique ? "narrowing" : "compatible"
    changes.push({ kind: "property-unique", propertyId, unique, effect })
  }

  return changes
}

function diffLink(
  linkId: string,
  stored: LinkShape | undefined,
  code: LinkShape | undefined
): TypeShapeChange[] {
  if (!stored) return [{ kind: "link-added", linkId, effect: "compatible" }]
  if (!code) return [{ kind: "link-removed", linkId, effect: "narrowing" }]

  // Links an earlier definition left behind may target anything: declaring the id again is
  // decided by whether they still exist.
  if (stored.unknown) return [{ kind: "link-added", linkId, effect: "refused" }]

  const changes: TypeShapeChange[] = []

  if (stored.cardinality !== code.cardinality) {
    changes.push({ kind: "link-cardinality", linkId, to: code.cardinality, effect: "refused" })
  }

  if (!sameShape(stored.targets, code.targets)) {
    // A link that still accepts every type it accepted widens: a target added, a supertype or a
    // new subtype, `link.any`. A type it no longer accepts, such as a subtype that left the
    // hierarchy, retargets it.
    const widens =
      code.targets.includes("*") || stored.targets.every((target) => code.targets.includes(target))
    const effect = widens ? "compatible" : "refused"
    changes.push({ kind: "link-targets", linkId, from: stored.targets, to: code.targets, effect })
  }

  return changes
}

function propertyShape(
  property: Property,
  valueTypes: ReadonlyMap<string, ValueType>,
  primary: boolean
): PropertyShape {
  return {
    ...(primary ? { primary: true as const } : {}),
    ...(property.mode === "telemetry" ? { mode: "telemetry" as const } : {}),
    ...(property.nullable ? { nullable: true as const } : {}),
    ...(property.required ? { required: true as const } : {}),
    schema: schemaShape(property.schema, valueTypes, new Set()),
    ...(property.unique ? { unique: true as const } : {}),
  }
}

function linkShape(link: ObjectLink, ontology: OntologyDefinitionCatalog): LinkShape {
  return {
    cardinality: link.cardinality ?? "many",
    targets: linkTargetObjectTypeIds(link.targetObjectTypeId, ontology) ?? ["*"],
  }
}

/** A schema with every value type it references written in place, and its keys sorted. */
function schemaShape(
  schema: Schema,
  valueTypes: ReadonlyMap<string, ValueType>,
  seen: ReadonlySet<string>
): SchemaShape {
  if (typeof schema === "string") return schema

  switch (schema.type) {
    case "valueTypeRef": {
      const valueType = valueTypes.get(schema.valueTypeId)
      if (!valueType || seen.has(valueType.id)) return { valueType: schema.valueTypeId }

      return schemaShape(valueType.schema, valueTypes, new Set([...seen, valueType.id]))
    }
    case "enum":
      return {
        type: "enum",
        valueType: schema.valueType,
        values: [...schema.values],
      } as SchemaShape
    case "array":
      return { items: schemaShape(schema.items, valueTypes, seen), type: "array" }
    case "map":
      return {
        keySchema: schema.keySchema,
        type: "map",
        valueSchema: schemaShape(schema.valueSchema, valueTypes, seen),
      }
    case "object": {
      const fields: Record<string, FieldShape> = {}
      for (const fieldId of Object.keys(schema.properties).sort()) {
        const field = schema.properties[fieldId]!
        fields[fieldId] = {
          ...(field.nullable ? { nullable: true as const } : {}),
          ...(field.required ? { required: true as const } : {}),
          schema: schemaShape(field.schema, valueTypes, seen),
        }
      }
      return { properties: fields, type: "object" }
    }
  }
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

function unionOfKeys(left: object, right: object): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
}

/**
 * Whether two shapes, or parts of them, are the same. A stored shape comes back with its keys in
 * the store's order, so canonical forms are compared.
 */
export function sameShape(left: unknown, right: unknown): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right)
}

/** How a schema's unique values compare, when the shape says: a value type's is not written in. */
function uniqueKeyKind(schema: SchemaShape): string | undefined {
  if (typeof schema === "string")
    return schema === "unknown" ? undefined : primitiveTraits(schema)?.unique
  if ("type" in schema && schema.type === "enum") return schema.valueType
  return undefined
}
