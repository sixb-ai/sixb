/**
 * Core schema language for ontology modeling.
 *
 * In Sixb, an Object Type ontology is built from:
 * - scalar values (for simple facts),
 * - structured values (for nested records), and
 * - links (for relationships between object types).
 *
 * This file defines the value-shape side of that model.
 */

import type { QuantitativeTypeId } from "./units"

/**
 * Atomic scalar values used by properties and nested fields.
 *
 * Use these for facts that do not need internal structure.
 *
 * Examples:
 * - `"string"` for a display name.
 * - `"uuid"` for an external system identifier.
 * - `"timestamp"` for `lastObservedAt`.
 * - `"fileRef"` for blob-backed documents, images, and attachments.
 * - `"double"` for telemetry such as temperature or humidity.
 */
export type PrimitiveSchema =
  | "string"
  | "integer"
  | "double"
  | "decimal"
  | "boolean"
  | "date"
  | "timestamp"
  | "uuid"
  | "fileRef"

export interface ValueTypeRefSchema {
  type: "valueTypeRef"
  valueTypeId: string
  /** Type-level: fully resolved schema for direct inference. Populated by codegen. */
  _resolved?: Schema
}

/**
 * Enumeration of allowed values.
 *
 * Use this when the domain is finite and explicit.
 *
 * Examples:
 * - HVAC mode: `{ type: "enum", valueType: "string", values: ["off", "heat", "cool", "auto"] }`
 * - Fan speed level: `{ type: "enum", valueType: "integer", values: [1, 2, 3] }`
 */
export type EnumSchema =
  | { type: "enum"; valueType: "string"; values: string[] }
  | { type: "enum"; valueType: "integer"; values: number[] }

/**
 * Field definition inside an inline object schema.
 *
 * `required` and `nullable` mirror top-level `Property` semantics:
 * - `required: true` means the field must be present.
 * - `nullable: true` means the field may be present with `null` value.
 */
export interface ObjectFieldSchema {
  description?: string
  required?: boolean
  /**
   * Physical quantity this field measures.
   *
   * Constrains which units are valid for this field's values.
   * Only meaningful when `schema` is a numeric type (`"double"`, `"integer"`, `"decimal"`).
   *
   * @example `semanticType: "Temperature"` — allows `degreeCelsius`, `degreeFahrenheit`, `kelvin`
   */
  semanticType?: QuantitativeTypeId
  nullable?: boolean
  schema: Schema
}

/**
 * Structured object with named fields.
 *
 * Example: a `temperatureRange` property with min and max fields,
 * both constrained to temperature units via `semanticType`.
 *
 * ```ts
 * {
 *   type: "object",
 *   properties: {
 *     min: { required: true, schema: "double", semanticType: "Temperature" },
 *     max: { required: true, schema: "double", semanticType: "Temperature" },
 *     value: { required: true, schema: "double" },
 *     unit: { required: true, schema: { type: "enum", valueType: "string", values: ["C", "F"] } }
 *   }
 * }
 * ```
 */
export interface ObjectSchema {
  type: "object"
  properties: Record<string, ObjectFieldSchema>
}

/**
 * Ordered collection of values.
 *
 * Use when order matters or duplicates are allowed.
 *
 * Examples:
 * - A sequence of fault codes sorted by recency.
 * - A list of related sensor ids: `{ type: "array", items: "uuid" }`.
 */
export interface ArraySchema {
  type: "array"
  items: Schema
}

/**
 * Key/value dictionary for dynamic or sparse attributes.
 *
 * `keySchema` is currently string-only, which fits most metadata maps.
 * `valueSchema` may be scalar or nested.
 *
 * Example:
 * `{ type: "map", keySchema: "string", valueSchema: "double" }`
 * for a map like `{ "phaseA": 12.3, "phaseB": 11.9 }`.
 */
export interface MapSchema {
  type: "map"
  keySchema: "string"
  valueSchema: Schema
}

/**
 * Recursive schema unions that enable deep composition.
 *
 * A `Schema` can be:
 * - a primitive,
 * - an enum/object/array/map,
 * - or a reference to a reusable `ValueType`.
 */
export type ComplexSchema = ObjectSchema | ArraySchema | MapSchema | EnumSchema
export type Schema = PrimitiveSchema | ComplexSchema | ValueTypeRefSchema

/**
 * Reusable named value contract.
 *
 * Use `ValueType` when multiple properties share the same semantic shape.
 * ```ts
 * {
 *   id: "temperatureReading",
 *   name: "Temperature Reading",
 *   schema: "double",
 *   semanticType: "Temperature",
 * }
 * ```
 *
 * Then reference it from properties via `ValueTypeRefSchema` to keep
 * ontology definitions consistent and easier to evolve.
 */
export interface ValueType {
  id: string
  name: string
  description?: string
  schema: Schema
  /**
   * Physical quantity this value type measures.
   *
   * When set, any property referencing this value type inherits the constraint,
   * and only units belonging to this quantity are valid.
   */
  semanticType?: QuantitativeTypeId
}

/**
 * Query/indexing metadata for an object or link property.
 *
 * `searchable` is the opt-in gate. More specific flags describe which query
 * surfaces may use the property once a storage provider supports them.
 */
export interface PropertyQueryMetadata {
  /** Enables the property for query indexing. Required when any specific flag is set. */
  searchable?: boolean
  /** Enables property predicates such as equality/range filters. */
  filterable?: boolean
  /** Enables deterministic ordering by this property. */
  sortable?: boolean
  /** Enables keyword search over this property. String-like schemas only. */
  text?: boolean
  /** Enables exact-match search over this property. */
  exact?: boolean
  /** Enables faceting/grouping in search results. */
  facet?: boolean
  /** Enables vector search when the property stores numeric embedding arrays. */
  vector?: boolean
  /** Relative text-search weight. Only meaningful with `text: true`. */
  weight?: number
}

/**
 * Object-level search profile.
 *
 * Search profiles decide which fields a global or type-scoped search uses.
 * Primary ids remain exact-matchable even if omitted here.
 */
export interface ObjectTypeSearchMetadata {
  /** Display/title property used in search results. */
  title?: string
  /** Default keyword-search fields for this object type. */
  defaultText?: readonly string[]
  /** Exact-match fields such as external ids, slugs, or emails. */
  exact?: readonly string[]
  /** Vector-search configuration for semantic retrieval. */
  vector?: {
    /** Property that stores the embedding vector. */
    property: string
    /** Source text properties used to produce the embedding. */
    source: readonly string[]
  }
}

/**
 * Attribute on an `ObjectType` (or on a relationship via `ObjectLink.properties`).
 * - `serialNumber` (string)
 * - `manufacturer` (string)
 * - `currentTemperature` (double, semanticType: "Temperature")
 *
 * Use `semanticType` to declare what physical quantity a numeric property
 * measures. This constrains which units are valid for the property's values.
 *
 * ```ts
 * {
 *   id: "currentTemperature",
 *   name: "Current Temperature",
 *   schema: "double",
 *   semanticType: "Temperature", // only Temperature units are valid
 * }
 * ```
 *
 * Prefer `links` for relationships to other entities.
 */
export interface Property {
  id: string
  name: string
  schema: Schema
  description?: string
  required?: boolean
  nullable?: boolean
  /**
   * Marks this property as the primary identifier for the object type.
   *
   * A primary property uniquely identifies an object instance within its type
   * (e.g., `externalId`). At most one property per object type may be primary.
   *
   * Only `true` is accepted — there is no "explicitly not primary" concept.
   * Validation and runtime enforcement are handled separately.
   */
  primary?: true
  /**
   * Runtime behavior of this property's value.
   *
   * - `"static"` (default) — a fact that rarely changes, stored as part of the object record.
   * - `"telemetry"` — a time-varying measurement; each value is appended to a time-series
   *   store and the object record holds only the latest value.
   *
   * @default "static"
   */
  mode?: PropertyMode
  /**
   * Physical quantity this property measures.
   *
   * Constrains which units are valid for this property's values.
   * Only meaningful when `schema` is a numeric type (`"double"`, `"integer"`, `"decimal"`).
   *
   * @example `semanticType: "Temperature"` — allows `degreeCelsius`, `degreeFahrenheit`, `kelvin`
   * @example `semanticType: "Pressure"` — allows `bar`, `pascal`, `millibar`, etc.
   */
  semanticType?: QuantitativeTypeId
  /** Query/indexing metadata for this property. */
  query?: PropertyQueryMetadata
}

/**
 * How a property's value behaves at runtime.
 *
 * - `"static"` — a fact that rarely changes (serial number, manufacturer).
 *    Stored as part of the object record.
 * - `"telemetry"` — a time-varying measurement or sensor reading.
 *    Each new value is appended to a time-series store and the object
 *    record holds only the latest value.
 *
 * When omitted, the property is treated as static.
 */
export type PropertyMode = "static" | "telemetry"

export type LinkCardinality = "one" | "many"

/**
 * Relationship from one object type to another object type.
 *
 * Use links for graph edges in the ontology.
 *
 * Example:
 * - `Building --contains--> Room` with `cardinality: "many"`
 * - `Room --hasPrimaryThermostat--> Thermostat` with `cardinality: "one"`
 *
 * Relationship instances can also carry metadata via `properties`, such as
 * `installedAt`, `commissionedBy`, or `confidenceScore`.
 */
export interface ObjectLink {
  id: string
  name: string
  description?: string
  targetObjectTypeId: string | string[]
  /** Cardinality from this source object to the target object type. */
  cardinality?: LinkCardinality
  /** Optional metadata attached to each relationship instance. */
  properties?: Property[]
}

declare const objectLinkTargetTypeBrand: unique symbol

/**
 * Type-only metadata attached by `link("id", Target)`.
 *
 * The runtime ontology still stores only `targetObjectTypeId`; this brand exists
 * only in TypeScript so query builders can resolve direct link targets without
 * consulting a generated id-to-type map.
 */
export type ObjectLinkTargetMetadata<TTarget> = {
  readonly [objectLinkTargetTypeBrand]?: TTarget
}

export type ObjectLinkTargetType<TLink> = typeof objectLinkTargetTypeBrand extends keyof TLink
  ? TLink extends ObjectLinkTargetMetadata<infer TTarget>
    ? TTarget
    : never
  : never

/**
 * Reusable ontology contract of properties and links.
 *
 * Define shared semantics once, then implement in multiple object types.
 *
 * Example:
 * - `Sensor` interface defines `manufacturer`, `model`, and link `locatedIn -> Space`.
 * - `TemperatureSensor` and `CO2Sensor` object types both implement `Sensor`.
 */
export interface Interface {
  id: string
  name: string
  description?: string
  properties: Property[]
  links: ObjectLink[]
}

/**
 * Canonical ontology node for a real-world asset, system, concept, or process.
 *
 * `ObjectType` is the primary modeling unit in Sixb ontology design.
 * It combines:
 * - `properties` for intrinsic attributes,
 * - `links` for relationships,
 * - and optional `implements` references for shared contracts.
 *
 * Example object types:
 * - `Thermostat`
 * - `HVACZone`
 * - `AirHandlingUnit`
 */
export interface ObjectType {
  id: string
  name: string
  description?: string

  /**
   * Physical quantity this object type measures.
   * Used for sensor/point types (e.g., Temperature_Sensor measures "Temperature").
   */
  quantityKind?: QuantitativeTypeId

  /** External documentation or reference URLs. */
  seeAlso?: string[]

  /** Parent object type id. Properties and links are inherited from the parent chain. */
  extends?: string

  /**
   * All parent type ids (includes extends).
   *
   * Used for multi-parent classification.
   * The primary structural parent (property merge) is stored in `extends`.
   * Additional parents are recorded here for subtype queries.
   *
   * Example: A Boiler is both an HVAC_Equipment (extends) and a Water_Heater (additional parent).
   * `parents: ["acme:Document", "acme:HRDocument"]`
   */
  parents?: string[]

  /**
   * Interface implementation by id.
   *
   * Example:
   * `implements: ["sensor", "commissionable"]`
   */
  implements?: string[] // interface ids

  properties: Property[]
  links: ObjectLink[]
  /** Search profile for this object type. */
  search?: ObjectTypeSearchMetadata
}

/**
 * Ambient id-to-object-type index for app ontology definitions.
 *
 * Sixb generates a `.sixb/types/ontology.d.ts` module augmentation that adds
 * entries here, letting client-side query types resolve string link targets
 * like `"Customer"` to the exported `Customer` object type without changing the
 * runtime ontology shape.
 */
// biome-ignore lint/suspicious/noEmptyInterface: App code augments this interface.
export interface SixbObjectTypeMap {}

/**
 * Root ontology document for object type modeling.
 *
 * Use this as the top-level container when you want to version and ship
 * a complete ontology definition.
 */
export interface Ontology {
  id: string
  version: string
  objectTypes: ObjectType[]
  valueTypes: ValueType[]
  interfaces: Interface[]
}
