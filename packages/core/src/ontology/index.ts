/**
 * Ontology modeling — public API.
 *
 * Types define the schema language; helpers provide ergonomic builders.
 *
 * ```ts
 * import { defineObjectType, prop, link, stringEnum } from "@sixb/core"
 * ```
 */

// ── Types ───────────────────────────────────────────────────

export type { InferSchemaOrRef, ObjectRef, ObjectRefSchema, SchemaOrRef } from "./refs"
export { isObjectRefSchema, ref, validateSchemaOrRefValue } from "./refs"
export type {
  LinkToken,
  LinkTokenMap,
  ObjectTypeWithPropertyTokens,
  ObjectTypeWithTokens,
  PropertyToken,
  PropertyTokenMap,
} from "./tokens"
export type {
  ArraySchema,
  ComplexSchema,
  EnumSchema,
  Interface,
  LinkCardinality,
  MapSchema,
  ObjectFieldSchema,
  ObjectLink,
  ObjectSchema,
  ObjectType,
  ObjectTypeSearchMetadata,
  Ontology,
  PrimitiveSchema,
  Property,
  PropertyMode,
  PropertyQueryMetadata,
  Schema,
  SixbObjectTypeMap,
  ValueType,
  ValueTypeRefSchema,
} from "./types"

// ── Registry ──────────────────────────────────────────────

export type { OntologyDocumentInput, OntologyRegistryOptions, OntologySource } from "./registry"
export { OntologyRegistry } from "./registry"

// ── Errors ─────────────────────────────────────────────────

export { OntologyValidationError } from "./errors"

// ── Helpers ─────────────────────────────────────────────────

export {
  defineInterface,
  defineObjectType,
  defineOntology,
  defineValueType,
  integerEnum,
  link,
  prop,
  stringEnum,
  valueTypeRef,
} from "./builders"
export { createLinkTokenMap, createPropertyTokenMap } from "./tokens"
export * from "./units"
export * from "./validation"
