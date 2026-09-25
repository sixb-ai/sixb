import type { UserRef } from "@sixb/core"
import { type FileRef, isFileRef } from "@sixb/core/blob-storage"

/**
 * Schema-driven value rendering.
 *
 * Atlas renders a value from the schema it was declared with, never from the
 * value's shape: a user-defined record that happens to look like
 * `{ objectTypeId, primaryId }` is a record, and a string that happens to look
 * like an ISO date is a string. Renderers walk the schema and the value
 * together and ask this module what each position is.
 *
 * Two states are deliberately distinct:
 * - no `ValueSchema` at all: the value is open (e.g. arbitrary run output), and
 *   renderers may fall back to shape heuristics;
 * - a `ValueSchema` whose node is `unknown`: a schema exists but Atlas cannot
 *   read it (an unresolvable `valueTypeRef`, a field the schema does not name).
 *   Renderers format that value generically and never guess its type.
 *
 * A value that does not match its node (a `fileRef` field holding a string)
 * also renders generically.
 */

/** Value type id → schema, collected from the ontology metadata Atlas loads. */
export type ValueTypeSchemas = ReadonlyMap<string, unknown>

/** One position in a schema, plus the value types needed to resolve refs below it. */
export interface ValueSchema {
  readonly schema: unknown
  readonly valueTypes: ValueTypeSchemas
}

export type ValueSchemaNode =
  | { readonly kind: "unknown" }
  | {
      readonly kind:
        | "string"
        | "uuid"
        | "integer"
        | "double"
        | "decimal"
        | "boolean"
        | "date"
        | "timestamp"
        | "fileRef"
        | "userRef"
    }
  | { readonly kind: "enum" }
  | { readonly kind: "objectRef"; readonly objectTypeId: string }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ValueSchema>> }
  | { readonly kind: "array"; readonly items: ValueSchema }
  | { readonly kind: "map"; readonly values: ValueSchema }

export interface ObjectRefValue {
  readonly objectTypeId: string
  readonly primaryId: string
}

const noValueTypes: ValueTypeSchemas = new Map()
const unknownNode: ValueSchemaNode = { kind: "unknown" }
const unknownValueSchema: ValueSchema = { schema: undefined, valueTypes: noValueTypes }

const primitiveKinds = new Set<string>([
  "string",
  "uuid",
  "integer",
  "double",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "fileRef",
  "userRef",
])

export function valueSchema(
  schema: unknown,
  valueTypes: ValueTypeSchemas = noValueTypes
): ValueSchema {
  return { schema, valueTypes }
}

/**
 * Describes one schema position, following `valueTypeRef`s. Children stay
 * unresolved `ValueSchema`s so recursive value types cost nothing until a
 * renderer actually descends into them.
 */
export function describeValueSchema({ schema, valueTypes }: ValueSchema): ValueSchemaNode {
  const resolved = resolveValueTypeRefs(schema, valueTypes)
  if (typeof resolved === "string") {
    return primitiveKinds.has(resolved)
      ? ({ kind: resolved } as ValueSchemaNode)
      : // A primitive name this Atlas build does not know yet.
        unknownNode
  }
  if (!isRecord(resolved)) return unknownNode

  switch (resolved.type) {
    case "enum":
      return Array.isArray(resolved.values) ? { kind: "enum" } : unknownNode
    case "objectRef":
      return typeof resolved.objectTypeId === "string"
        ? { kind: "objectRef", objectTypeId: resolved.objectTypeId }
        : unknownNode
    case "object": {
      if (!isRecord(resolved.properties)) return unknownNode
      const fields = Object.fromEntries(
        Object.entries(resolved.properties).map(([fieldId, field]) => [
          fieldId,
          { schema: isRecord(field) ? field.schema : undefined, valueTypes },
        ])
      )
      return { kind: "object", fields }
    }
    case "array":
      return "items" in resolved
        ? { kind: "array", items: { schema: resolved.items, valueTypes } }
        : unknownNode
    case "map":
      return "valueSchema" in resolved
        ? { kind: "map", values: { schema: resolved.valueSchema, valueTypes } }
        : unknownNode
    default:
      return unknownNode
  }
}

/**
 * Schema of the child at `key` for any container node (object field, array
 * item, map value). A field the object schema does not name, and anything below
 * a non-container, is `unknown`.
 */
export function childValueSchema(node: ValueSchemaNode, key: string): ValueSchema {
  switch (node.kind) {
    case "object":
      return Object.hasOwn(node.fields, key) ? node.fields[key] : unknownValueSchema
    case "array":
      return node.items
    case "map":
      return node.values
    default:
      return unknownValueSchema
  }
}

/** The file ref at a `fileRef` position, or null when the value does not match the schema. */
export function fileRefAt(node: ValueSchemaNode, value: unknown): FileRef | null {
  return node.kind === "fileRef" && isFileRef(value) ? value : null
}

/** The object ref at an `objectRef` position, or null when the value does not match the schema. */
export function objectRefAt(node: ValueSchemaNode, value: unknown): ObjectRefValue | null {
  if (node.kind !== "objectRef" || !isRecord(value)) return null
  const { objectTypeId, primaryId } = value
  return typeof objectTypeId === "string" && typeof primaryId === "string"
    ? { objectTypeId, primaryId }
    : null
}

/** The user ref at a `userRef` position, or null when the value does not match the schema. */
export function userRefAt(node: ValueSchemaNode, value: unknown): UserRef | null {
  if (node.kind !== "userRef" || !isRecord(value)) return null
  const { type, id } = value
  return type === "user" && typeof id === "string" && id.length > 0 ? { type, id } : null
}

/**
 * Collects value type schemas from every `valueTypeRef` that carries its
 * resolved schema inline — what `valueTypeRef(MyValueType)` emits. This mirrors
 * how the runtime registers value types from the same schemas. A ref declared
 * by id alone, with its value type registered only on the server, stays
 * unresolved here and renders as `unknown`.
 */
export function collectValueTypeSchemas(schemas: Iterable<unknown>): Map<string, unknown> {
  const collected = new Map<string, unknown>()
  const visit = (schema: unknown): void => {
    if (!isRecord(schema)) return
    switch (schema.type) {
      case "valueTypeRef":
        if (
          typeof schema.valueTypeId === "string" &&
          schema._resolved !== undefined &&
          !collected.has(schema.valueTypeId)
        ) {
          collected.set(schema.valueTypeId, schema._resolved)
          visit(schema._resolved)
        }
        return
      case "object":
        if (isRecord(schema.properties)) {
          for (const field of Object.values(schema.properties)) {
            if (isRecord(field)) visit(field.schema)
          }
        }
        return
      case "array":
        visit(schema.items)
        return
      case "map":
        visit(schema.valueSchema)
        return
    }
  }
  for (const schema of schemas) visit(schema)
  return collected
}

interface SchemaCarrier {
  readonly schema?: unknown
}

/** The object type metadata `ontologySchemas` reads; `listObjectTypes` items satisfy it. */
export interface OntologySchemaSource {
  readonly properties: readonly SchemaCarrier[]
  readonly links?: readonly { readonly properties?: readonly SchemaCarrier[] }[]
  readonly actions?: readonly { readonly params: readonly SchemaCarrier[] }[]
}

/** Every schema declared by these object types: properties, link properties, action params. */
export function ontologySchemas(objectTypes: readonly OntologySchemaSource[]): unknown[] {
  return objectTypes.flatMap((objectType) => [
    ...objectType.properties.map((property) => property.schema),
    ...(objectType.links ?? []).flatMap((link) =>
      (link.properties ?? []).map((property) => property.schema)
    ),
    ...(objectType.actions ?? []).flatMap((action) => action.params.map((param) => param.schema)),
  ])
}

/**
 * Wraps a record of named field schemas — action params, workflow inputs — as
 * one `object` schema. Each entry is either a bare schema or a field config
 * carrying `schema`.
 */
export function fieldRecordSchema(fields: Readonly<Record<string, unknown>>): unknown {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fields).map(([fieldId, descriptor]) => [
        fieldId,
        { schema: isRecord(descriptor) && "schema" in descriptor ? descriptor.schema : descriptor },
      ])
    ),
  }
}

function resolveValueTypeRefs(schema: unknown, valueTypes: ValueTypeSchemas): unknown {
  let current = schema
  const seen = new Set<string>()
  while (isRecord(current) && current.type === "valueTypeRef") {
    const valueTypeId = current.valueTypeId
    if (typeof valueTypeId !== "string" || seen.has(valueTypeId)) return undefined
    seen.add(valueTypeId)
    current = current._resolved !== undefined ? current._resolved : valueTypes.get(valueTypeId)
  }
  return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
