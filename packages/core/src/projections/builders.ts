/**
 * Projection DSL builders, helpers, and type guards.
 *
 * Uses the same fluent builder style as the other definition APIs.
 */

import type {
  DatasetColumnDefinitionOf,
  DatasetColumnNameOf,
  DatasetColumnType,
  DatasetColumnTypeOf,
  DatasetDefinition,
} from "../datasets"
import type { LinkToken, PropertyToken } from "../ontology/tokens"
import type { ObjectLink, ObjectType, Property, Schema } from "../ontology/types"
import { ProjectionValidationError } from "./errors"
import type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  LinkProjectionTarget,
  ObjectProjectionDefinition,
  ObjectProjectionTarget,
  ProjectionDefinition,
  ProjectionTarget,
  SourceEditConflictResolution,
  TelemetryProjectionDefinition,
  TelemetryProjectionPropertyMapping,
} from "./types"
import {
  validateAndLowerLinkMapping,
  validateLinkProjectionTarget,
  validatePropertyMapping,
} from "./validation"

// ── Internal helpers ─────────────────────────────────────────

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ProjectionValidationError(`Projection ${field} must not be empty.`)
  }
}

function assertProjectionDataset(dataset: DatasetDefinition): void {
  if (!dataset || dataset.kind !== "dataset" || typeof dataset.id !== "string") {
    throw new ProjectionValidationError("Projection dataset must be a dataset definition.")
  }
  assertNonEmpty(dataset.id, "dataset id")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// ── Type utilities ───────────────────────────────────────────

/** Union of property ids from an ObjectType. */
type PropertyIdOf<T extends ObjectType> = T["properties"][number]["id"]

/** Property definition by id from an ObjectType. */
type PropertyById<T extends ObjectType, TPropertyId extends PropertyIdOf<T>> = Extract<
  T["properties"][number],
  { id: TPropertyId }
>

/** Union of link ids from an ObjectType. */
type LinkIdOf<T extends ObjectType> = T["links"][number]["id"]

type LinkById<T extends ObjectType, TLinkId extends LinkIdOf<T>> = Extract<
  T["links"][number],
  { id: TLinkId }
>

type SingleTargetIdOf<TLink extends ObjectLink> = TLink["targetObjectTypeId"] extends string
  ? TLink["targetObjectTypeId"]
  : never

type ResolvedProjectionSchema<TSchema extends Schema> = TSchema extends {
  type: "valueTypeRef"
  _resolved: infer TResolved extends Schema
}
  ? ResolvedProjectionSchema<TResolved>
  : TSchema extends { type: "valueTypeRef" }
    ? never
    : TSchema

type StringCompatibleProjectionSchema =
  | "string"
  | "uuid"
  | { type: "enum"; values: readonly string[] }

type IntegerCompatibleProjectionSchema =
  | "integer"
  | "double"
  | "decimal"
  | { type: "enum"; values: readonly number[] }

type JsonCompatibleProjectionSchema = { type: "object" | "array" | "map" | "enum" }

type ProjectionSchemaByDatasetColumnType = {
  readonly string: StringCompatibleProjectionSchema
  readonly boolean: "boolean"
  readonly int64: IntegerCompatibleProjectionSchema
  readonly float64: "double"
  readonly decimal: "decimal" | "double"
  readonly date: "date"
  readonly timestamp: "timestamp"
  readonly json: JsonCompatibleProjectionSchema
  readonly fileRef: "fileRef"
}

type DatasetColumnCompatibleWithSchema<
  TColumnType extends DatasetColumnType,
  TSchema extends Schema,
> = [ResolvedProjectionSchema<TSchema>] extends [never]
  ? false
  : ResolvedProjectionSchema<TSchema> extends ProjectionSchemaByDatasetColumnType[TColumnType]
    ? true
    : false

type DatasetColumnNameCompatibleWithSchema<
  TDataset extends DatasetDefinition,
  TSchema extends Schema,
> =
  string extends DatasetColumnNameOf<TDataset>
    ? string
    : {
        [TColumnName in DatasetColumnNameOf<TDataset>]: DatasetColumnCompatibleWithSchema<
          DatasetColumnTypeOf<TDataset, TColumnName>,
          TSchema
        > extends true
          ? TColumnName
          : never
      }[DatasetColumnNameOf<TDataset>]

type StringDatasetColumnNameOf<TDataset extends DatasetDefinition> =
  string extends DatasetColumnNameOf<TDataset>
    ? string
    : {
        [TColumnName in DatasetColumnNameOf<TDataset>]: DatasetColumnTypeOf<
          TDataset,
          TColumnName
        > extends "string"
          ? TColumnName
          : never
      }[DatasetColumnNameOf<TDataset>]

type DateLikeDatasetColumnNameOf<TDataset extends DatasetDefinition> =
  string extends DatasetColumnNameOf<TDataset>
    ? string
    : {
        [TColumnName in DatasetColumnNameOf<TDataset>]: DatasetColumnTypeOf<
          TDataset,
          TColumnName
        > extends "string" | "date" | "timestamp"
          ? TColumnName
          : never
      }[DatasetColumnNameOf<TDataset>]

type TimestampDatasetColumnNameOf<TDataset extends DatasetDefinition> =
  string extends DatasetColumnNameOf<TDataset>
    ? string
    : {
        [TColumnName in DatasetColumnNameOf<TDataset>]: DatasetColumnTypeOf<
          TDataset,
          TColumnName
        > extends "timestamp"
          ? DatasetColumnDefinitionOf<TDataset, TColumnName> extends { readonly nullable: true }
            ? never
            : TColumnName
          : never
      }[DatasetColumnNameOf<TDataset>]

type ProjectionMappingFor<TObjectType extends ObjectType, TDataset extends DatasetDefinition> = {
  readonly [TPropertyId in PropertyIdOf<TObjectType>]?: DatasetColumnNameCompatibleWithSchema<
    TDataset,
    PropertyById<TObjectType, TPropertyId>["schema"]
  >
}

type ExactProjectionMapping<TObjectType extends ObjectType, TMapping> = TMapping & {
  readonly [TKey in Exclude<keyof TMapping, PropertyIdOf<TObjectType>>]: never
}

type TelemetryPropertyToken<TObjectTypeId extends string = string> = PropertyToken<
  TObjectTypeId,
  string,
  Property & { readonly mode: "telemetry" }
>

type TelemetryPropertyOf<TObjectType extends ObjectType> = Extract<
  TObjectType["properties"][number],
  { readonly mode: "telemetry" }
>

type TelemetryPropertyIdOf<TObjectType extends ObjectType> = TelemetryPropertyOf<TObjectType>["id"]

type TelemetryPropertyById<
  TObjectType extends ObjectType,
  TPropertyId extends TelemetryPropertyIdOf<TObjectType>,
> = Extract<TelemetryPropertyOf<TObjectType>, { readonly id: TPropertyId }>

type TelemetryProjectionPointMapping<
  TPropertyToken extends TelemetryPropertyToken,
  TDataset extends DatasetDefinition,
> = {
  readonly objectId: StringDatasetColumnNameOf<TDataset>
  readonly at: DateLikeDatasetColumnNameOf<TDataset>
  readonly value: DatasetColumnNameCompatibleWithSchema<
    TDataset,
    TPropertyToken["property"]["schema"]
  >
  readonly unit?: StringDatasetColumnNameOf<TDataset>
}

type ExactTelemetryProjectionPointMapping<TMapping> = TMapping & {
  readonly [TKey in Exclude<keyof TMapping, "objectId" | "at" | "value" | "unit">]: never
}

type TelemetryProjectionPropertyInput<
  TProperty extends Property,
  TDataset extends DatasetDefinition,
> =
  | DatasetColumnNameCompatibleWithSchema<TDataset, TProperty["schema"]>
  | {
      readonly value: DatasetColumnNameCompatibleWithSchema<TDataset, TProperty["schema"]>
      readonly unit: StringDatasetColumnNameOf<TDataset>
    }

type TelemetryProjectionPropertiesMapping<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
> = {
  readonly [TPropertyId in TelemetryPropertyIdOf<TObjectType>]?: TelemetryProjectionPropertyInput<
    TelemetryPropertyById<TObjectType, TPropertyId>,
    TDataset
  >
}

type ExactTelemetryProjectionPropertiesMapping<
  TObjectType extends ObjectType,
  TMapping,
> = TMapping & {
  readonly [TKey in Exclude<keyof TMapping, TelemetryPropertyIdOf<TObjectType>>]: never
}

type ExactTelemetryProjectionPropertyInputs<TMapping> = {
  readonly [TPropertyId in keyof TMapping]: TMapping[TPropertyId] extends object
    ? TMapping[TPropertyId] & {
        readonly [TKey in Exclude<keyof TMapping[TPropertyId], "value" | "unit">]: never
      }
    : TMapping[TPropertyId]
}

type NonEmptyTelemetryProjectionProperties<TMapping> = keyof TMapping extends never
  ? never
  : TMapping

type TelemetryProjectionPropertiesPointMapping<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
  TProperties,
> = {
  readonly objectId: StringDatasetColumnNameOf<TDataset>
  readonly at: DateLikeDatasetColumnNameOf<TDataset>
  readonly properties: NonEmptyTelemetryProjectionProperties<
    ExactTelemetryProjectionPropertiesMapping<TObjectType, TProperties> &
      ExactTelemetryProjectionPropertyInputs<TProperties>
  >
}

type ForeignKeyFromSourceProperty = Omit<
  ForeignKeyDescriptor,
  "sourcePropertyId" | "sourceField"
> & {
  readonly sourcePropertyId: string
  readonly sourceField?: never
}

type ForeignKeyFromSourceField<TSourceField extends string = string> = Omit<
  ForeignKeyDescriptor,
  "sourcePropertyId" | "sourceField"
> & {
  readonly sourcePropertyId?: never
  readonly sourceField: TSourceField
}

type ProjectionForeignKeyDescriptor<TDataset extends DatasetDefinition> =
  | ForeignKeyFromSourceProperty
  | ForeignKeyFromSourceField<StringDatasetColumnNameOf<TDataset>>

type ProjectionForeignKeyTokenInput<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
  TLinkId extends LinkIdOf<TObjectType>,
> =
  | {
      readonly link: LinkToken<
        TObjectType["id"],
        TLinkId,
        SingleTargetIdOf<LinkById<TObjectType, TLinkId>>
      >
      readonly sourceProperty: PropertyToken<TObjectType["id"]>
      readonly target: ObjectType &
        (
          | { id: NoInfer<SingleTargetIdOf<LinkById<TObjectType, TLinkId>>> }
          | { extends: NoInfer<SingleTargetIdOf<LinkById<TObjectType, TLinkId>>> }
        )
    }
  | {
      readonly link: LinkToken<
        TObjectType["id"],
        TLinkId,
        SingleTargetIdOf<LinkById<TObjectType, TLinkId>>
      >
      readonly sourceField: StringDatasetColumnNameOf<TDataset>
      readonly target: ObjectType &
        (
          | { id: NoInfer<SingleTargetIdOf<LinkById<TObjectType, TLinkId>>> }
          | { extends: NoInfer<SingleTargetIdOf<LinkById<TObjectType, TLinkId>>> }
        )
    }

export type ProjectionForeignKeyInput<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
  TLinkId extends LinkIdOf<TObjectType>,
> =
  | ProjectionForeignKeyDescriptor<TDataset>
  | ProjectionForeignKeyTokenInput<TObjectType, TDataset, TLinkId>

function lowerForeignKeyMapping<TObjectType extends ObjectType, TDataset extends DatasetDefinition>(
  mapping: {
    [K in LinkIdOf<TObjectType>]?: ProjectionForeignKeyInput<TObjectType, TDataset, K>
  }
): Record<string, ForeignKeyDescriptor> {
  const lowered: Record<string, ForeignKeyDescriptor> = {}
  for (const [linkId, descriptor] of Object.entries(mapping)) {
    if (!descriptor) continue
    lowered[linkId] = isForeignKeyDescriptor(descriptor)
      ? descriptor
      : fromForeignKey(descriptor as Parameters<typeof fromForeignKey>[0])
  }
  return lowered
}

function isForeignKeyDescriptor(value: unknown): value is ForeignKeyDescriptor {
  return isRecord(value) && typeof value.linkId === "string"
}

// ── defineProjection ─────────────────────────────────────────

interface ObjectTypeProjectionSourceBuilder<TObjectType extends ObjectType> {
  fromDataset<const TDataset extends DatasetDefinition>(
    dataset: TDataset
  ): ObjectTypeProjectionDatasetBuilder<TObjectType, TDataset>
}

interface ObjectTypeProjectionDatasetBuilder<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
> {
  properties<const TMapping extends ProjectionMappingFor<TObjectType, TDataset>>(
    mapping: ExactProjectionMapping<TObjectType, TMapping>
  ): ObjectProjectionBuilder<TObjectType, TDataset>
  points<const TProperties extends TelemetryProjectionPropertiesMapping<TObjectType, TDataset>>(
    mapping: TelemetryProjectionPropertiesPointMapping<TObjectType, TDataset, TProperties>
  ): TelemetryProjectionDefinition
}

export type ObjectProjectionConflictResolution<TDataset extends DatasetDefinition> =
  | { readonly strategy: "editsWin" }
  | {
      readonly strategy: "mostRecent"
      readonly sourceTimestamp: TimestampDatasetColumnNameOf<TDataset>
    }

export interface ObjectProjectionBuilder<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
> extends ObjectProjectionDefinition {
  readonly conflictResolution: SourceEditConflictResolution
  withLinks(
    mapping: { [K in LinkIdOf<TObjectType>]?: ProjectionForeignKeyInput<TObjectType, TDataset, K> }
  ): ObjectProjectionBuilder<TObjectType, TDataset>
  resolveConflicts(
    resolution: ObjectProjectionConflictResolution<TDataset>
  ): ObjectProjectionBuilder<TObjectType, TDataset>
}

/**
 * Defines an object, link, or telemetry projection from its ontology target.
 *
 * ```ts
 * defineProjection("room-projection", Room)
 *   .fromDataset(canonicalRoomsDataset)
 *   .properties({ id: "room_id", name: "room_name" })
 *   .withLinks({
 *     inBuilding: {
 *       link: Room.l.inBuilding,
 *       sourceField: "building_id",
 *       target: Building,
 *     },
 *   })
 * ```
 */
export function defineProjection<const TObjectType extends ObjectType>(
  id: string,
  objectType: TObjectType
): ObjectTypeProjectionSourceBuilder<TObjectType>
export function defineProjection<
  TObjectTypeId extends string,
  TLinkId extends string,
  TTargetObjectTypeId extends string,
>(
  id: string,
  linkToken: LinkToken<TObjectTypeId, TLinkId, TTargetObjectTypeId>
): LinkProjectionSourceBuilder
export function defineProjection<const TPropertyToken extends TelemetryPropertyToken>(
  id: string,
  propertyToken: TPropertyToken
): TelemetryProjectionSourceBuilder<TPropertyToken>
export function defineProjection(
  id: string,
  target: ObjectType | LinkToken<string, string, string> | TelemetryPropertyToken
):
  | ObjectTypeProjectionSourceBuilder<ObjectType>
  | LinkProjectionSourceBuilder
  | TelemetryProjectionSourceBuilder<TelemetryPropertyToken> {
  if ("link" in target) return buildLinkProjection(id, target)
  if ("property" in target) return buildTelemetryProjection(id, target)
  return buildObjectTypeProjection(id, target)
}

function buildObjectTypeProjection<const TObjectType extends ObjectType>(
  id: string,
  objectType: TObjectType
): ObjectTypeProjectionSourceBuilder<TObjectType> {
  assertNonEmpty(id, "id")

  return {
    fromDataset<const TDataset extends DatasetDefinition>(
      dataset: TDataset
    ): ObjectTypeProjectionDatasetBuilder<TObjectType, TDataset> {
      assertProjectionDataset(dataset)
      const datasetId = dataset.id

      return {
        properties<const TMapping extends ProjectionMappingFor<TObjectType, TDataset>>(
          mapping: ExactProjectionMapping<TObjectType, TMapping>
        ): ObjectProjectionBuilder<TObjectType, TDataset> {
          const propertyMapping = mapping as Record<string, string>
          validatePropertyMapping(objectType, propertyMapping)

          return objectProjectionBuilder({
            id,
            objectType,
            datasetId,
            propertyMapping,
            links: {},
            conflictResolution: { strategy: "editsWin" },
          })
        },
        points<
          const TProperties extends TelemetryProjectionPropertiesMapping<TObjectType, TDataset>,
        >(
          mapping: TelemetryProjectionPropertiesPointMapping<TObjectType, TDataset, TProperties>
        ): TelemetryProjectionDefinition {
          const pointMapping = lowerTelemetryPropertiesPointMapping(
            objectType,
            mapping as {
              readonly objectId?: string
              readonly at?: string
              readonly properties?: Readonly<Record<string, unknown>>
            }
          )
          return {
            _tag: "TelemetryProjectionDefinition",
            id,
            objectTypeId: objectType.id,
            datasetId,
            objectIdField: pointMapping.objectId,
            atField: pointMapping.at,
            properties: pointMapping.properties,
          }
        },
      }
    },
  }
}

function objectProjectionBuilder<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
>(input: {
  readonly id: string
  readonly objectType: TObjectType
  readonly datasetId: string
  readonly propertyMapping: Readonly<Record<string, string>>
  readonly links: Readonly<Record<string, ForeignKeyDescriptor>>
  readonly conflictResolution: SourceEditConflictResolution
}): ObjectProjectionBuilder<TObjectType, TDataset> {
  const definition: ObjectProjectionDefinition & {
    readonly conflictResolution: SourceEditConflictResolution
  } = {
    _tag: "ObjectProjectionDefinition",
    id: input.id,
    objectTypeId: input.objectType.id,
    datasetId: input.datasetId,
    properties: { ...input.propertyMapping },
    links: { ...input.links },
    conflictResolution: { ...input.conflictResolution },
  }

  return Object.assign(definition, {
    withLinks(
      linkMapping: {
        [K in LinkIdOf<TObjectType>]?: ProjectionForeignKeyInput<TObjectType, TDataset, K>
      }
    ): ObjectProjectionBuilder<TObjectType, TDataset> {
      const loweredLinkMapping = lowerForeignKeyMapping(linkMapping)
      const validatedLinks = validateAndLowerLinkMapping(
        input.objectType,
        loweredLinkMapping,
        input.propertyMapping as Record<string, string>
      )
      return objectProjectionBuilder({ ...input, links: validatedLinks })
    },
    resolveConflicts(
      resolution: ObjectProjectionConflictResolution<TDataset>
    ): ObjectProjectionBuilder<TObjectType, TDataset> {
      validateConflictResolution(resolution)
      return objectProjectionBuilder({
        ...input,
        conflictResolution: resolution as SourceEditConflictResolution,
      })
    },
  })
}

function validateConflictResolution(resolution: SourceEditConflictResolution): void {
  if (resolution.strategy === "editsWin") return
  assertNonEmpty(resolution.sourceTimestamp, "source timestamp field")
}

// ── Telemetry projection ────────────────────────────────────

interface TelemetryProjectionSourceBuilder<TPropertyToken extends TelemetryPropertyToken> {
  fromDataset<const TDataset extends DatasetDefinition>(
    dataset: TDataset
  ): TelemetryProjectionMappingBuilder<TPropertyToken, TDataset>
}

interface TelemetryProjectionMappingBuilder<
  TPropertyToken extends TelemetryPropertyToken,
  TDataset extends DatasetDefinition,
> {
  points<const TMapping extends TelemetryProjectionPointMapping<TPropertyToken, TDataset>>(
    mapping: ExactTelemetryProjectionPointMapping<TMapping>
  ): TelemetryProjectionDefinition
}

/**
 * Fluent builder for {@link TelemetryProjectionDefinition}.
 *
 * ```ts
 * defineProjection("room-temperatures", Room.p.temperature)
 *   .fromDataset(roomReadingsDataset)
 *   .points({
 *     objectId: "room_id",
 *     at: "observed_at",
 *     value: "temperature",
 *     unit: "unit",
 *   })
 * ```
 */
function buildTelemetryProjection<const TPropertyToken extends TelemetryPropertyToken>(
  id: string,
  propertyToken: TPropertyToken
): TelemetryProjectionSourceBuilder<TPropertyToken> {
  assertNonEmpty(id, "id")
  validateTelemetryProjectionProperty(propertyToken)

  return {
    fromDataset<const TDataset extends DatasetDefinition>(
      dataset: TDataset
    ): TelemetryProjectionMappingBuilder<TPropertyToken, TDataset> {
      assertProjectionDataset(dataset)
      const datasetId = dataset.id

      return {
        points<const TMapping extends TelemetryProjectionPointMapping<TPropertyToken, TDataset>>(
          mapping: ExactTelemetryProjectionPointMapping<TMapping>
        ): TelemetryProjectionDefinition {
          const pointMapping = lowerTelemetryPointMapping(mapping)
          return {
            _tag: "TelemetryProjectionDefinition",
            id,
            objectTypeId: propertyToken.objectTypeId,
            datasetId,
            objectIdField: pointMapping.objectId,
            atField: pointMapping.at,
            properties: {
              [propertyToken.id]: {
                valueField: pointMapping.value,
                ...(pointMapping.unit !== undefined ? { unitField: pointMapping.unit } : {}),
              },
            },
          }
        },
      }
    },
  }
}

function validateTelemetryProjectionProperty(propertyToken: PropertyToken): void {
  if (propertyToken.property.mode !== "telemetry") {
    throw new ProjectionValidationError(
      `Projection property '${propertyToken.objectTypeId}.${propertyToken.id}' must be telemetry-enabled.`
    )
  }
}

function lowerTelemetryPointMapping(mapping: {
  readonly objectId?: string
  readonly at?: string
  readonly value?: string
  readonly unit?: string
}): {
  readonly objectId: string
  readonly at: string
  readonly value: string
  readonly unit?: string
} {
  const allowedKeys = new Set(["objectId", "at", "value", "unit"])
  for (const key of Object.keys(mapping)) {
    if (!allowedKeys.has(key)) {
      throw new ProjectionValidationError(
        `Telemetry projection point mapping contains unknown key '${key}'.`
      )
    }
  }

  if (mapping.objectId === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires objectId.")
  }
  if (mapping.at === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires at.")
  }
  if (mapping.value === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires value.")
  }

  assertNonEmpty(mapping.objectId, "objectId field")
  assertNonEmpty(mapping.at, "at field")
  assertNonEmpty(mapping.value, "value field")
  if (mapping.unit !== undefined) {
    assertNonEmpty(mapping.unit, "unit field")
  }

  return {
    objectId: mapping.objectId,
    at: mapping.at,
    value: mapping.value,
    ...(mapping.unit !== undefined ? { unit: mapping.unit } : {}),
  }
}

function lowerTelemetryPropertiesPointMapping(
  objectType: ObjectType,
  mapping: {
    readonly objectId?: string
    readonly at?: string
    readonly properties?: Readonly<Record<string, unknown>>
  }
): {
  readonly objectId: string
  readonly at: string
  readonly properties: Readonly<Record<string, TelemetryProjectionPropertyMapping>>
} {
  const allowedKeys = new Set(["objectId", "at", "properties"])
  for (const key of Object.keys(mapping)) {
    if (!allowedKeys.has(key)) {
      throw new ProjectionValidationError(
        `Telemetry projection point mapping contains unknown key '${key}'.`
      )
    }
  }

  if (mapping.objectId === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires objectId.")
  }
  if (mapping.at === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires at.")
  }
  if (mapping.properties === undefined) {
    throw new ProjectionValidationError("Telemetry projection point mapping requires properties.")
  }
  if (!isRecord(mapping.properties)) {
    throw new ProjectionValidationError(
      "Telemetry projection point mapping properties must be an object."
    )
  }

  assertNonEmpty(mapping.objectId, "objectId field")
  assertNonEmpty(mapping.at, "at field")

  const propertyEntries = Object.entries(mapping.properties)
  if (propertyEntries.length === 0) {
    throw new ProjectionValidationError(
      "Telemetry projection point mapping requires at least one property."
    )
  }

  const propertiesById = new Map(objectType.properties.map((property) => [property.id, property]))
  const properties: Record<string, TelemetryProjectionPropertyMapping> = {}
  for (const [propertyId, input] of propertyEntries) {
    const property = propertiesById.get(propertyId)
    if (!property) {
      throw new ProjectionValidationError(
        `Property '${propertyId}' does not exist on object type '${objectType.id}'.`
      )
    }
    if (property.mode !== "telemetry") {
      throw new ProjectionValidationError(
        `Projection property '${objectType.id}.${propertyId}' must be telemetry-enabled.`
      )
    }
    properties[propertyId] = lowerTelemetryPropertyMapping(propertyId, input)
  }

  return { objectId: mapping.objectId, at: mapping.at, properties }
}

function lowerTelemetryPropertyMapping(
  propertyId: string,
  input: unknown
): TelemetryProjectionPropertyMapping {
  if (typeof input === "string") {
    assertNonEmpty(input, `property '${propertyId}' value field`)
    return { valueField: input }
  }
  if (!isRecord(input)) {
    throw new ProjectionValidationError(
      `Telemetry projection property '${propertyId}' must map a value column or value/unit columns.`
    )
  }

  const allowedKeys = new Set(["value", "unit"])
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw new ProjectionValidationError(
        `Telemetry projection property '${propertyId}' contains unknown key '${key}'.`
      )
    }
  }
  if (typeof input.value !== "string") {
    throw new ProjectionValidationError(
      `Telemetry projection property '${propertyId}' requires a value field.`
    )
  }
  if (typeof input.unit !== "string") {
    throw new ProjectionValidationError(
      `Telemetry projection property '${propertyId}' requires a unit field.`
    )
  }
  assertNonEmpty(input.value, `property '${propertyId}' value field`)
  assertNonEmpty(input.unit, `property '${propertyId}' unit field`)
  return { valueField: input.value, unitField: input.unit }
}

// ── fromForeignKey ───────────────────────────────────────────

/**
 * Creates a {@link ForeignKeyDescriptor} from typed tokens.
 *
 * Compile-time constraints:
 * - `TObjectTypeId` ties `link` and `sourceProperty` to the same object type
 *   when a projected source property is used.
 * - `TTargetObjectTypeId` (inferred from the link token) constrains `target`
 *   to an ObjectType whose `id` or `extends` matches the link's declared target.
 *   This covers exact type match and direct subtypes. Multi-level inheritance
 *   is validated at Sixb startup when the full type graph is available.
 *
 * ```ts
 * fromForeignKey({
 *   link: Room.l.inBuilding,
 *   sourceProperty: Room.p.buildingRef,
 *   target: Building,
 * })
 * ```
 */
export function fromForeignKey<
  TObjectTypeId extends string,
  TTargetObjectTypeId extends string,
>(input: {
  link: LinkToken<TObjectTypeId, string, TTargetObjectTypeId>
  sourceProperty: PropertyToken<TObjectTypeId>
  target: ObjectType &
    ({ id: NoInfer<TTargetObjectTypeId> } | { extends: NoInfer<TTargetObjectTypeId> })
}): ForeignKeyFromSourceProperty
export function fromForeignKey<
  TObjectTypeId extends string,
  TTargetObjectTypeId extends string,
  const TSourceField extends string,
>(input: {
  link: LinkToken<TObjectTypeId, string, TTargetObjectTypeId>
  sourceField: TSourceField
  target: ObjectType &
    ({ id: NoInfer<TTargetObjectTypeId> } | { extends: NoInfer<TTargetObjectTypeId> })
}): ForeignKeyFromSourceField<TSourceField>
export function fromForeignKey<
  TObjectTypeId extends string,
  TTargetObjectTypeId extends string,
>(input: {
  link: LinkToken<TObjectTypeId, string, TTargetObjectTypeId>
  sourceProperty?: PropertyToken<TObjectTypeId>
  sourceField?: string
  target: ObjectType &
    ({ id: NoInfer<TTargetObjectTypeId> } | { extends: NoInfer<TTargetObjectTypeId> })
}): ForeignKeyDescriptor {
  validateLinkProjectionTarget(input.link)

  if (input.sourceProperty) {
    return {
      linkId: input.link.id,
      sourcePropertyId: input.sourceProperty.id,
      targetObjectTypeId: input.target.id,
    }
  }

  if (input.sourceField === undefined) {
    throw new ProjectionValidationError("Foreign key sourceField is required.")
  }
  assertNonEmpty(input.sourceField, "source field")
  return {
    linkId: input.link.id,
    sourceField: input.sourceField,
    targetObjectTypeId: input.target.id,
  }
}

// ── Link projection ─────────────────────────────────────────

interface LinkProjectionSourceBuilder {
  fromDataset<const TDataset extends DatasetDefinition>(
    dataset: TDataset
  ): LinkProjectionFieldBuilder<TDataset>
}

interface LinkProjectionFieldBuilder<TDataset extends DatasetDefinition> {
  sourceField(
    columnName: StringDatasetColumnNameOf<TDataset>
  ): LinkProjectionTargetBuilder<TDataset>
}

interface LinkProjectionTargetBuilder<TDataset extends DatasetDefinition> {
  targetField(columnName: StringDatasetColumnNameOf<TDataset>): LinkProjectionDefinition
}

/**
 * Fluent builder for {@link LinkProjectionDefinition} (many-to-many join datasets).
 *
 * ```ts
 * defineProjection("room-sensor-links", Room.l.hasSensors)
 *   .fromDataset(roomSensorsDataset)
 *   .sourceField("room_id")
 *   .targetField("sensor_id")
 * ```
 */
function buildLinkProjection<
  TObjectTypeId extends string,
  TLinkId extends string,
  TTargetObjectTypeId extends string,
>(
  id: string,
  linkToken: LinkToken<TObjectTypeId, TLinkId, TTargetObjectTypeId>
): LinkProjectionSourceBuilder {
  assertNonEmpty(id, "id")
  validateLinkProjectionTarget(linkToken)

  return {
    fromDataset<const TDataset extends DatasetDefinition>(
      dataset: TDataset
    ): LinkProjectionFieldBuilder<TDataset> {
      assertProjectionDataset(dataset)
      const datasetId = dataset.id

      return {
        sourceField(
          columnName: StringDatasetColumnNameOf<TDataset>
        ): LinkProjectionTargetBuilder<TDataset> {
          assertNonEmpty(columnName, "source field")

          return {
            targetField(
              targetColumnName: StringDatasetColumnNameOf<TDataset>
            ): LinkProjectionDefinition {
              assertNonEmpty(targetColumnName, "target field")

              return {
                _tag: "LinkProjectionDefinition",
                id,
                linkId: linkToken.id,
                sourceObjectTypeId: linkToken.objectTypeId,
                targetObjectTypeId: linkToken.targetObjectTypeId as string,
                datasetId,
                sourceField: columnName,
                targetField: targetColumnName,
              }
            },
          }
        },
      }
    },
  }
}

// ── Type guards ──────────────────────────────────────────────

/** Runtime type guard for {@link ObjectProjectionDefinition}. */
export function isObjectProjectionDefinition(value: unknown): value is ObjectProjectionDefinition {
  if (!isRecord(value)) return false
  return (
    value._tag === "ObjectProjectionDefinition" &&
    typeof value.id === "string" &&
    typeof value.objectTypeId === "string" &&
    typeof value.datasetId === "string" &&
    isRecord(value.properties) &&
    isRecord(value.links) &&
    isSourceEditConflictResolution(value.conflictResolution)
  )
}

function isSourceEditConflictResolution(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || typeof value.strategy !== "string") return false
  if (value.strategy === "editsWin") return value.sourceTimestamp === undefined
  return value.strategy === "mostRecent" && typeof value.sourceTimestamp === "string"
}

/** Runtime type guard for {@link LinkProjectionDefinition}. */
export function isLinkProjectionDefinition(value: unknown): value is LinkProjectionDefinition {
  if (!isRecord(value)) return false
  return (
    value._tag === "LinkProjectionDefinition" &&
    typeof value.id === "string" &&
    typeof value.linkId === "string" &&
    typeof value.sourceObjectTypeId === "string" &&
    typeof value.targetObjectTypeId === "string" &&
    typeof value.datasetId === "string" &&
    typeof value.sourceField === "string" &&
    typeof value.targetField === "string"
  )
}

/** Runtime type guard for {@link TelemetryProjectionDefinition}. */
export function isTelemetryProjectionDefinition(
  value: unknown
): value is TelemetryProjectionDefinition {
  if (!isRecord(value)) return false
  return (
    value._tag === "TelemetryProjectionDefinition" &&
    typeof value.id === "string" &&
    typeof value.objectTypeId === "string" &&
    typeof value.datasetId === "string" &&
    typeof value.objectIdField === "string" &&
    typeof value.atField === "string" &&
    isTelemetryProjectionProperties(value.properties)
  )
}

function isTelemetryProjectionProperties(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  return Object.values(value).every(
    (mapping) =>
      isRecord(mapping) &&
      typeof mapping.valueField === "string" &&
      (mapping.unitField === undefined || typeof mapping.unitField === "string")
  )
}

/** Runtime type guard for any {@link ProjectionDefinition}. */
export function isProjectionDefinition(value: unknown): value is ProjectionDefinition {
  return (
    isObjectProjectionDefinition(value) ||
    isLinkProjectionDefinition(value) ||
    isTelemetryProjectionDefinition(value)
  )
}

/**
 * Extracts the object type id(s) a projection targets, used to authorize run
 * visibility (`object.view`). Link projections require both ends; object and
 * telemetry projections target a single type.
 */
export function projectionTargetOf(projection: LinkProjectionDefinition): LinkProjectionTarget
export function projectionTargetOf(
  projection: ObjectProjectionDefinition | TelemetryProjectionDefinition
): ObjectProjectionTarget
export function projectionTargetOf(projection: ProjectionDefinition): ProjectionTarget
export function projectionTargetOf(projection: ProjectionDefinition): ProjectionTarget {
  return projection._tag === "LinkProjectionDefinition"
    ? {
        sourceObjectTypeId: projection.sourceObjectTypeId,
        targetObjectTypeId: projection.targetObjectTypeId,
      }
    : { objectTypeId: projection.objectTypeId }
}

// ── Categorization ──────────────────────────────────────────

/** Splits a mixed list of projection definitions into typed arrays by tag. */
export function categorizeProjections(projections: readonly ProjectionDefinition[]): {
  objectProjections: ObjectProjectionDefinition[]
  linkProjections: LinkProjectionDefinition[]
  telemetryProjections: TelemetryProjectionDefinition[]
} {
  const objectProjections: ObjectProjectionDefinition[] = []
  const linkProjections: LinkProjectionDefinition[] = []
  const telemetryProjections: TelemetryProjectionDefinition[] = []
  for (const projection of projections) {
    if (isObjectProjectionDefinition(projection)) {
      objectProjections.push(projection)
    } else if (isLinkProjectionDefinition(projection)) {
      linkProjections.push(projection)
    } else if (isTelemetryProjectionDefinition(projection)) {
      telemetryProjections.push(projection)
    }
  }
  return { objectProjections, linkProjections, telemetryProjections }
}
