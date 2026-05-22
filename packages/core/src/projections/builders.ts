/**
 * Projection DSL builders, helpers, and type guards.
 *
 * Follows the fluent builder pattern established in `defineFunction()`.
 */

import type {
  DatasetColumnNameOf,
  DatasetColumnType,
  DatasetColumnTypeOf,
  DatasetDefinition,
} from "../datasets"
import type { LinkToken, PropertyToken } from "../ontology/tokens"
import type { ObjectType, Schema } from "../ontology/types"
import { ProjectionValidationError } from "./errors"
import type {
  ForeignKeyDescriptor,
  LinkProjectionDefinition,
  ObjectProjectionDefinition,
  ProjectionDefinition,
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
  readonly float64: "double" | "decimal"
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

type ProjectionMappingFor<TObjectType extends ObjectType, TDataset extends DatasetDefinition> = {
  readonly [TPropertyId in PropertyIdOf<TObjectType>]?: DatasetColumnNameCompatibleWithSchema<
    TDataset,
    PropertyById<TObjectType, TPropertyId>["schema"]
  >
}

type ExactProjectionMapping<TObjectType extends ObjectType, TMapping> = TMapping & {
  readonly [TKey in Exclude<keyof TMapping, PropertyIdOf<TObjectType>>]: never
}

// ── defineProjection ─────────────────────────────────────────

interface ProjectionSourceBuilder<TObjectType extends ObjectType> {
  fromDataset<const TDataset extends DatasetDefinition>(
    dataset: TDataset
  ): ProjectionMappingBuilder<TObjectType, TDataset>
}

interface ProjectionMappingBuilder<
  TObjectType extends ObjectType,
  TDataset extends DatasetDefinition,
> {
  properties<const TMapping extends ProjectionMappingFor<TObjectType, TDataset>>(
    mapping: ExactProjectionMapping<TObjectType, TMapping>
  ): ObjectProjectionDefinition & ProjectionLinkBuilder<TObjectType>
}

interface ProjectionLinkBuilder<TObjectType extends ObjectType> {
  withLinks(
    mapping: { [K in LinkIdOf<TObjectType>]?: ForeignKeyDescriptor }
  ): ObjectProjectionDefinition
}

/**
 * Fluent builder for {@link ObjectProjectionDefinition}.
 *
 * ```ts
 * defineProjection("room-projection", Room)
 *   .fromDataset(canonicalRoomsDataset)
 *   .properties({ id: "room_id", name: "room_name", buildingRef: "building_id" })
 *   .withLinks({
 *     inBuilding: fromForeignKey({
 *       link: Room.l.inBuilding,
 *       sourceProperty: Room.p.buildingRef,
 *       target: Building,
 *     }),
 *   })
 * ```
 */
export function defineProjection<const TObjectType extends ObjectType>(
  id: string,
  objectType: TObjectType
): ProjectionSourceBuilder<TObjectType> {
  assertNonEmpty(id, "id")

  return {
    fromDataset<const TDataset extends DatasetDefinition>(
      dataset: TDataset
    ): ProjectionMappingBuilder<TObjectType, TDataset> {
      assertProjectionDataset(dataset)
      const datasetId = dataset.id

      return {
        properties<const TMapping extends ProjectionMappingFor<TObjectType, TDataset>>(
          mapping: ExactProjectionMapping<TObjectType, TMapping>
        ): ObjectProjectionDefinition & ProjectionLinkBuilder<TObjectType> {
          const propertyMapping = mapping as Record<string, string>
          validatePropertyMapping(objectType, propertyMapping)

          const definition: ObjectProjectionDefinition = {
            _tag: "ObjectProjectionDefinition",
            id,
            objectTypeId: objectType.id,
            datasetId,
            properties: { ...propertyMapping },
            links: {},
          }

          return Object.assign(definition, {
            withLinks(
              linkMapping: { [K in LinkIdOf<TObjectType>]?: ForeignKeyDescriptor }
            ): ObjectProjectionDefinition {
              const validatedLinks = validateAndLowerLinkMapping(
                objectType,
                linkMapping as Record<string, ForeignKeyDescriptor>,
                propertyMapping
              )

              return {
                _tag: "ObjectProjectionDefinition",
                id,
                objectTypeId: objectType.id,
                datasetId,
                properties: { ...propertyMapping },
                links: validatedLinks,
              }
            },
          })
        },
      }
    },
  }
}

// ── fromForeignKey ───────────────────────────────────────────

/**
 * Creates a {@link ForeignKeyDescriptor} from typed tokens.
 *
 * Compile-time constraints:
 * - `TObjectTypeId` ties `link` and `sourceProperty` to the same object type.
 * - `TTargetObjectTypeId` (inferred from the link token) constrains `target`
 *   to an ObjectType whose `id` or `extends` matches the link's declared target.
 *   This covers exact type match and direct subtypes. Multi-level inheritance
 *   is validated at Pario startup when the full type graph is available.
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
}): ForeignKeyDescriptor {
  validateLinkProjectionTarget(input.link)

  return {
    linkId: input.link.id,
    sourcePropertyId: input.sourceProperty.id,
    targetObjectTypeId: input.target.id,
  }
}

// ── defineLinkProjection ─────────────────────────────────────

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
 * defineLinkProjection("room-sensor-links", Room.l.hasSensors)
 *   .fromDataset(roomSensorsDataset)
 *   .sourceField("room_id")
 *   .targetField("sensor_id")
 * ```
 */
export function defineLinkProjection<
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
    isRecord(value.links)
  )
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

/** Runtime type guard for any {@link ProjectionDefinition}. */
export function isProjectionDefinition(value: unknown): value is ProjectionDefinition {
  return isObjectProjectionDefinition(value) || isLinkProjectionDefinition(value)
}

// ── Categorization ──────────────────────────────────────────

/** Splits a mixed list of projection definitions into typed arrays by tag. */
export function categorizeProjections(projections: readonly ProjectionDefinition[]): {
  objectProjections: ObjectProjectionDefinition[]
  linkProjections: LinkProjectionDefinition[]
} {
  const objectProjections: ObjectProjectionDefinition[] = []
  const linkProjections: LinkProjectionDefinition[] = []
  for (const projection of projections) {
    if (isObjectProjectionDefinition(projection)) {
      objectProjections.push(projection)
    } else if (isLinkProjectionDefinition(projection)) {
      linkProjections.push(projection)
    }
  }
  return { objectProjections, linkProjections }
}
