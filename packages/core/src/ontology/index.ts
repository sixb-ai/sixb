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

export type { EmbeddingModelDefinition, EmbeddingModelRef } from "../models/embedding-model"
export type { DecimalValue } from "./decimal"
export {
  compareDecimalValues,
  decimal,
  isDecimalString,
  isDecimalValue,
  normalizeDecimalValue,
} from "./decimal"
export type {
  LinkPathSelection,
  LinkPathSelectionBuilder,
  LinkPathSelectionInput,
  LinkPathSelectionMode,
} from "./link-path-selection"
export type { InferSchemaOrRef, ObjectRef, ObjectRefSchema, SchemaOrRef } from "./refs"
export { isObjectRefSchema, objectRef, ref } from "./refs"
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
  ObjectLinkTargetMetadata,
  ObjectLinkTargetType,
  ObjectSchema,
  ObjectType,
  ObjectTypeSearchMetadata,
  ObjectVectorSearchProfile,
  Ontology,
  PrimitiveSchema,
  Property,
  PropertyMode,
  PropertyQueryMetadata,
  Schema,
  SixbObjectTypeMap,
  SixbValueTypeMap,
  ValueType,
  ValueTypeRefSchema,
} from "./types"
export type { UserRef } from "./user-ref"
export { userRef } from "./user-ref"

// ── Registry ──────────────────────────────────────────────

export type {
  OntologyDefinitionCatalog,
  OntologyDocumentInput,
  OntologyRegistryOptions,
  OntologySource,
} from "./registry"
export { OntologyRegistry } from "./registry"

// ── Errors ─────────────────────────────────────────────────

export { OntologyNotFoundError, OntologyValidationError } from "./errors"

// ── Helpers ─────────────────────────────────────────────────

export type { DirectLinkResult, DirectLinkTarget } from "./builders"
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
export * from "./units"
