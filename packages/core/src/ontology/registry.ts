/**
 * Standalone ontology registry — owns all type state and resolution logic.
 *
 * Zero infrastructure dependencies: imports only from the `ontology/` module.
 * Other modules depend on `OntologyRegistry` instead of coupling to the full
 * `Sixb` facade.
 */

import { SixbError } from "../errors"
import { formatUnknownObjectTypeMessage } from "./errors"
import type { ObjectTypeWithPropertyTokens } from "./tokens"
import { createLinkTokenMap, createPropertyTokenMap } from "./tokens"
import type { ObjectType, Schema, ValueType } from "./types"
import {
  validatePrimaryProperties,
  validatePropertyDefinitions,
  validateQueryMetadata,
} from "./validation"

// ── Input types ──────────────────────────────────────────────

/** Typed wrapper used by `createSixb` to register full ontology documents. */
export type OntologyDocumentInput = {
  readonly id: string
  readonly version: string
  readonly objectTypes: readonly ObjectTypeWithPropertyTokens[]
  readonly valueTypes?: readonly ValueType[]
}

/**
 * Runtime accepts either full ontology documents or individual object types.
 * This keeps setup flexible while preserving strict typing.
 */
export type OntologySource = ObjectTypeWithPropertyTokens | OntologyDocumentInput

export interface OntologyRegistryOptions {
  readonly sources: readonly OntologySource[]
}

// ── Private helpers ──────────────────────────────────────────

function isOntologyDocumentSource(
  source: OntologySource
): source is Exclude<OntologySource, ObjectTypeWithPropertyTokens> {
  return "objectTypes" in source
}

/**
 * Recursively walk a schema tree and collect ValueTypes discovered
 * via `valueTypeRef` nodes that carry a `_resolved` schema.
 *
 * This enables auto-registration: when codegen emits `valueTypeRef(VT)`,
 * it stores the resolved schema inline. We extract it here so the runtime
 * `valueTypesById` registry is populated without requiring users to pass
 * ValueTypes explicitly.
 */
function extractValueTypesFromSchema(
  schema: Schema,
  collected: Map<string, ValueType>,
  seen: Set<string>
): void {
  if (typeof schema === "string") return

  if (schema.type === "valueTypeRef") {
    if (schema._resolved && !seen.has(schema.valueTypeId)) {
      seen.add(schema.valueTypeId)
      const localName = schema.valueTypeId.includes(":")
        ? schema.valueTypeId.slice(schema.valueTypeId.indexOf(":") + 1)
        : schema.valueTypeId
      collected.set(schema.valueTypeId, {
        id: schema.valueTypeId,
        name: localName,
        schema: schema._resolved,
      })
      extractValueTypesFromSchema(schema._resolved, collected, seen)
    }
    return
  }

  if (schema.type === "object") {
    for (const field of Object.values(schema.properties)) {
      extractValueTypesFromSchema(field.schema, collected, seen)
    }
    return
  }

  if (schema.type === "array") {
    extractValueTypesFromSchema(schema.items, collected, seen)
    return
  }

  if (schema.type === "map") {
    extractValueTypesFromSchema(schema.valueSchema, collected, seen)
  }
}

function collectOntology(sources: readonly OntologySource[]): {
  objectTypes: ObjectTypeWithPropertyTokens[]
  valueTypes: ValueType[]
} {
  const objectTypes: ObjectTypeWithPropertyTokens[] = []
  const valueTypes: ValueType[] = []
  const seenObjectTypes = new Set<ObjectTypeWithPropertyTokens>()

  for (const source of sources) {
    if (isOntologyDocumentSource(source)) {
      for (const ot of source.objectTypes) {
        if (!seenObjectTypes.has(ot)) {
          seenObjectTypes.add(ot)
          objectTypes.push(ot)
        }
      }
      valueTypes.push(...(source.valueTypes ?? []))
    } else {
      if (!seenObjectTypes.has(source)) {
        seenObjectTypes.add(source)
        objectTypes.push(source)
      }
    }
  }

  // Auto-discover ValueTypes embedded in ObjectType schemas via _resolved.
  // Explicit ValueTypes (from OntologyDocumentInput) take priority.
  const explicitIds = new Set(valueTypes.map((vt) => vt.id))
  const discovered = new Map<string, ValueType>()

  for (const objectType of objectTypes) {
    for (const property of objectType.properties) {
      extractValueTypesFromSchema(property.schema, discovered, explicitIds)
    }
    for (const linkDef of objectType.links) {
      if (linkDef.properties) {
        for (const property of linkDef.properties) {
          extractValueTypesFromSchema(property.schema, discovered, explicitIds)
        }
      }
    }
  }

  valueTypes.push(...discovered.values())

  return { objectTypes, valueTypes }
}

// ── OntologyRegistry ─────────────────────────────────────────

/**
 * Self-contained registry for ontology types.
 *
 * Holds all object types, value types, the subtype graph, and the primary
 * property mapping. Validates inheritance chains and flattens inherited
 * properties at construction time.
 *
 * Exposes read-only accessors so consumers never mutate ontology state.
 */
export class OntologyRegistry {
  private readonly objectTypesById = new Map<string, ObjectTypeWithPropertyTokens>()
  private readonly valueTypesById = new Map<string, ValueType>()
  private readonly subTypesById = new Map<string, Set<string>>()
  private readonly primaryByTypeId: Map<string, string>

  constructor(options: OntologyRegistryOptions) {
    const { objectTypes, valueTypes } = collectOntology(options.sources)

    for (const objectType of objectTypes) {
      if (this.objectTypesById.has(objectType.id)) {
        throw new SixbError("ontology.invalid_value", `Duplicate object type id: ${objectType.id}`)
      }
      this.objectTypesById.set(objectType.id, objectType)
    }

    for (const valueType of valueTypes) {
      if (this.valueTypesById.has(valueType.id)) {
        throw new SixbError("ontology.invalid_value", `Duplicate value type id: ${valueType.id}`)
      }
      this.valueTypesById.set(valueType.id, valueType)
    }

    this.validateAndBuildExtendsRegistry()
    this.resolveInheritedProperties()
    validatePropertyDefinitions(this.objectTypesById, this.valueTypesById)
    validateQueryMetadata(this.objectTypesById, this.valueTypesById)
    this.primaryByTypeId = validatePrimaryProperties(this.objectTypesById)
  }

  // ── Public read API ──────────────────────────────────────

  /** All registered object types. */
  listObjectTypes(): readonly ObjectTypeWithPropertyTokens[] {
    return [...this.objectTypesById.values()]
  }

  /** Lookup an object type by id. Returns `null` if not found. */
  getObjectTypeById(objectTypeId: string): ObjectTypeWithPropertyTokens | null {
    return this.objectTypesById.get(objectTypeId) ?? null
  }

  /**
   * Lookup an object type by id, throwing if it does not exist.
   *
   * Use this when the caller requires the type to exist and should fail
   * loudly on unknown types (e.g., write operations receiving a type id).
   */
  resolveObjectType(objectTypeId: string): ObjectTypeWithPropertyTokens {
    const objectType = this.objectTypesById.get(objectTypeId)
    if (!objectType) {
      throw new SixbError("ontology.type_not_found", formatUnknownObjectTypeMessage(objectTypeId))
    }
    return objectType
  }

  /** Get the primary property id for a given object type. Throws if unknown. */
  getPrimaryPropertyId(objectTypeId: string): string {
    const id = this.primaryByTypeId.get(objectTypeId)
    if (!id)
      throw new SixbError("ontology.type_not_found", formatUnknownObjectTypeMessage(objectTypeId))
    return id
  }

  /** Collect all transitive sub-types of the given object type id. */
  listSubTypes(objectTypeId: string): string[] {
    const result: string[] = []
    const collect = (typeId: string): void => {
      const children = this.subTypesById.get(typeId)
      if (!children) return
      for (const childId of children) {
        result.push(childId)
        collect(childId)
      }
    }
    collect(objectTypeId)
    return result
  }

  /** Get the structural extends chain from root ancestor to the provided type. */
  listAncestorChain(objectType: ObjectType): readonly ObjectTypeWithPropertyTokens[] {
    const chain: ObjectTypeWithPropertyTokens[] = []
    let current: ObjectTypeWithPropertyTokens | null = this.resolveObjectType(objectType.id)
    const seen = new Set<string>()

    while (current) {
      if (seen.has(current.id)) {
        throw new SixbError(
          "ontology.invalid_value",
          `Circular extends chain detected while resolving ancestors for "${objectType.id}".`
        )
      }
      seen.add(current.id)
      chain.push(current)
      current = current.extends ? this.resolveObjectType(current.extends) : null
    }

    return chain.reverse()
  }

  /**
   * Check whether `actual` is a valid target for a link expecting `expected`.
   *
   * Supports wildcard `"*"`, single concrete types, and arrays. A type
   * matches if it equals the expected type or is a transitive subtype.
   */
  isValidLinkTarget(expected: string | string[], actual: string): boolean {
    if (expected === "*") return true
    const types = Array.isArray(expected) ? expected : [expected]
    if (types.includes("*")) return true
    for (const type of types) {
      if (actual === type || this.listSubTypes(type).includes(actual)) return true
    }
    return false
  }

  // ── Map accessors (read-only views) ──────────────────────

  /** Read-only view of all object types by id. */
  getObjectTypesById(): ReadonlyMap<string, ObjectTypeWithPropertyTokens> {
    return this.objectTypesById
  }

  /** Read-only view of all value types by id. */
  getValueTypesById(): ReadonlyMap<string, ValueType> {
    return this.valueTypesById
  }

  /** Read-only view of primary property ids by object type id. */
  getPrimaryByTypeId(): ReadonlyMap<string, string> {
    return this.primaryByTypeId
  }

  // ── Private initialization ───────────────────────────────

  /**
   * Build the subtype graph from `extends` and `parents` declarations.
   *
   * Validates that parent types exist and detects circular `extends` chains.
   */
  private validateAndBuildExtendsRegistry(): void {
    const resolving = new Set<string>()
    const resolved = new Set<string>()

    const registerChild = (parentId: string, childId: string): void => {
      let children = this.subTypesById.get(parentId)
      if (!children) {
        children = new Set()
        this.subTypesById.set(parentId, children)
      }
      children.add(childId)
    }

    const visit = (typeId: string, chain: string[]): void => {
      if (resolved.has(typeId)) return

      const objectType = this.objectTypesById.get(typeId)
      if (!objectType || !objectType.extends) {
        resolved.add(typeId)
        return
      }

      const parentId = objectType.extends

      if (!this.objectTypesById.has(parentId)) {
        throw new SixbError(
          "ontology.invalid_value",
          `ObjectType "${typeId}" extends unknown type "${parentId}". If "${parentId}" comes from an external ontology, add it to 'ontologies' in createSixb().`
        )
      }

      if (resolving.has(typeId)) {
        throw new SixbError(
          "ontology.invalid_value",
          `Circular extends chain detected: ${[...chain, typeId].join(" → ")}`
        )
      }

      resolving.add(typeId)
      visit(parentId, [...chain, typeId])

      registerChild(parentId, typeId)

      resolving.delete(typeId)
      resolved.add(typeId)
    }

    for (const typeId of this.objectTypesById.keys()) {
      visit(typeId, [])
    }

    for (const [typeId, objectType] of this.objectTypesById) {
      if (!objectType.parents) continue
      for (const parentId of objectType.parents) {
        if (parentId === objectType.extends) continue
        if (!this.objectTypesById.has(parentId)) {
          throw new SixbError(
            "ontology.invalid_value",
            `ObjectType "${typeId}" lists unknown parent "${parentId}" in parents. If "${parentId}" comes from an external ontology, add it to 'ontologies' in createSixb().`
          )
        }
        registerChild(parentId, typeId)
      }
    }
  }

  /**
   * For types with string `extends`, merge parent properties/links
   * and rebuild tokens. Idempotent: no-op if already flattened (codegen case).
   */
  private resolveInheritedProperties(): void {
    const resolved = new Set<string>()

    const resolve = (typeId: string): void => {
      if (resolved.has(typeId)) return
      const objectType = this.objectTypesById.get(typeId)!

      if (!objectType.extends) {
        resolved.add(typeId)
        return
      }

      resolve(objectType.extends)
      const parent = this.objectTypesById.get(objectType.extends)!

      const mergeById = <T extends { id: string }>(
        parentItems: readonly T[],
        childItems: readonly T[]
      ): T[] => {
        const childIds = new Set(childItems.map((item) => item.id))
        const fromParent = parentItems.filter((item) => !childIds.has(item.id))
        return [...fromParent, ...childItems]
      }

      const mergedProperties = mergeById(parent.properties, objectType.properties)
      const mergedLinks = mergeById(parent.links, objectType.links)

      const changed =
        mergedProperties.length !== objectType.properties.length ||
        mergedLinks.length !== objectType.links.length

      if (changed) {
        const merged: ObjectType = {
          ...objectType,
          properties: mergedProperties,
          links: mergedLinks,
        }
        const withTokens: ObjectTypeWithPropertyTokens = {
          ...merged,
          p: createPropertyTokenMap(merged),
        }
        ;(withTokens as ObjectTypeWithPropertyTokens & { l: unknown }).l =
          createLinkTokenMap(merged)
        this.objectTypesById.set(typeId, withTokens)
      }

      resolved.add(typeId)
    }

    for (const typeId of this.objectTypesById.keys()) {
      resolve(typeId)
    }
  }
}
