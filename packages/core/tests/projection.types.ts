import {
  col,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  defineValueType,
  fromForeignKey,
  link,
  prop,
  stringEnum,
  valueTypeRef,
} from "../src"

/**
 * Compile-time contract tests for projection builder literal inference.
 *
 * This file is intentionally type-only (no runtime `bun:test` cases).
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const _Building = defineObjectType({
  id: "building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const temperatureReading = defineValueType({
  id: "temperatureReading",
  name: "Temperature Reading",
  schema: "double",
})

const _Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("buildingRef", "string"),
    prop("roomNumber", "integer"),
    prop("area", "double"),
    prop("openedOn", "date"),
    prop("lastSeenAt", "timestamp"),
    prop("mode", stringEnum(["occupied", "vacant"])),
    prop("metadata", {
      type: "object",
      properties: {
        floor: { schema: "integer" },
      },
    }),
    prop("reading", valueTypeRef(temperatureReading)),
    prop("unresolvedReading", valueTypeRef("temperatureReading")),
  ],
  links: [
    link("inBuilding", _Building, { cardinality: "one" }),
    link("hasSensors", "sensor", { cardinality: "many" }),
  ],
})

const roomDataset = defineDataset("canonical.rooms", {
  schema: [
    col("col_id", "string"),
    col("col_name", "string"),
    col("col_ref", "string"),
    col("col_room_number", "int64"),
    col("col_area", "float64"),
    col("col_opened_on", "date"),
    col("col_last_seen_at", "timestamp"),
    col("col_mode", "string"),
    col("col_metadata", "json"),
    col("col_reading", "decimal"),
  ],
})

const roomSensorsDataset = defineDataset("join.room-sensors", {
  schema: [col("room_id", "string"), col("sensor_id", "string"), col("weight", "int64")],
})

// 1. defineProjection infers ObjectType generics, result has correct _tag
const projection = defineProjection("test", _Room).fromDataset(roomDataset).properties({
  id: "col_id",
  name: "col_name",
  buildingRef: "col_ref",
  roomNumber: "col_room_number",
  area: "col_area",
  openedOn: "col_opened_on",
  lastSeenAt: "col_last_seen_at",
  mode: "col_mode",
  metadata: "col_metadata",
  reading: "col_reading",
})
type _projTag = Expect<Equal<typeof projection._tag, "ObjectProjectionDefinition">>

// 2. .fromDataset() accepts dataset definitions, not string ids
// @ts-expect-error — string dataset ids are no longer accepted
defineProjection("test", _Room).fromDataset("ds")

// 3. .properties() keys auto-complete from ObjectType property ids
// @ts-expect-error — unknown property key "unknownProp"
defineProjection("test", _Room).fromDataset(roomDataset).properties({ unknownProp: "col_id" })

// 4. .properties() values auto-complete from dataset column names
defineProjection("test", _Room)
  .fromDataset(roomDataset)
  // @ts-expect-error — unknown dataset column name
  .properties({ id: "missing_column" })

// 5. .properties() validates DatasetColumnType -> Property.schema compatibility
defineProjection("test", _Room)
  .fromDataset(roomDataset)
  // @ts-expect-error — int64 column cannot map to a string property
  .properties({ id: "col_room_number" })

// 6. unresolved valueTypeRef properties are rejected
defineProjection("test", _Room)
  .fromDataset(roomDataset)
  // @ts-expect-error — valueTypeRef("id") has no resolved schema for projection typing
  .properties({ id: "col_id", unresolvedReading: "col_reading" })

// 7. .withLinks() keys auto-complete from ObjectType link ids
projection.withLinks({
  // @ts-expect-error — unknown link key "unknownLink"
  unknownLink: { linkId: "x", sourcePropertyId: "y", targetObjectTypeId: "z" },
})

// 8. fromForeignKey constrains link + sourceProperty to same objectTypeId
fromForeignKey({
  link: _Room.l.inBuilding,
  sourceProperty: _Room.p.buildingRef,
  target: _Building,
}) // OK — both tokens from Room, target matches link's declared target

// 9. @ts-expect-error — cross-type fromForeignKey (Room link + Building property)
fromForeignKey({ link: _Room.l.inBuilding, sourceProperty: _Building.p.name, target: _Building })

// 10. fromForeignKey rejects unrelated target type
const _Unrelated = defineObjectType({
  id: "unrelated",
  name: "Unrelated",
  properties: [prop("id", "string", { required: true, primary: true })],
})
fromForeignKey({
  link: _Room.l.inBuilding,
  sourceProperty: _Room.p.buildingRef,
  // @ts-expect-error — target "unrelated" is not "building" and doesn't extend it
  target: _Unrelated,
})

// 11. fromForeignKey accepts direct subtype (extends matches link target)
const _OfficeBuilding = defineObjectType({
  id: "office-building",
  name: "Office Building",
  extends: _Building,
  properties: [prop("floor", "string")],
})
fromForeignKey({
  link: _Room.l.inBuilding,
  sourceProperty: _Room.p.buildingRef,
  target: _OfficeBuilding,
}) // OK — extends "building"

// 12. defineLinkProjection with valid single-target link
const linkProj = defineLinkProjection("test", _Room.l.hasSensors)
  .fromDataset(roomSensorsDataset)
  .sourceField("room_id")
  .targetField("sensor_id")
type _linkProjTag = Expect<Equal<typeof linkProj._tag, "LinkProjectionDefinition">>

defineLinkProjection("test", _Room.l.hasSensors)
  .fromDataset(roomSensorsDataset)
  // @ts-expect-error — link projection fields must be string columns
  .sourceField("weight")
