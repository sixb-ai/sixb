import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  fromForeignKey,
  isLinkProjectionDefinition,
  isObjectProjectionDefinition,
  isProjectionDefinition,
  isTelemetryProjectionDefinition,
  link,
  ProjectionValidationError,
  prop,
} from "../src"
import { categorizeProjections } from "../src/projections"

// ── Test fixtures ────────────────────────────────────────────

const Building = defineObjectType({
  id: "building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Room = defineObjectType({
  id: "room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("buildingRef", "string"),
    prop("sensorRef", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
    prop("humidity", "double", { mode: "telemetry" }),
  ],
  links: [
    link("inBuilding", Building, { cardinality: "one" }),
    link.ref("hasSensors", "sensor", { cardinality: "many" }),
  ],
})

const canonicalRoomsDataset = defineDataset("canonical.rooms", {
  schema: [
    col("room_id", "string"),
    col("room_name", "string"),
    col("building_id", "string"),
    col("building_ref", "string"),
    col("updated_at", "timestamp"),
  ],
})

const genericDataset = defineDataset("ds", {
  schema: [col("col", "string"), col("ref", "string"), col("a", "string"), col("b", "string")],
})

const roomSensorsDataset = defineDataset("join.room-sensors", {
  schema: [col("room_id", "string"), col("sensor_id", "string")],
})

const roomReadingsDataset = defineDataset("canonical.room-readings", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("temperature", "float64"),
    col("humidity", "float64"),
    col("unit", "string"),
  ],
})

const TypeWithPolymorphicLink = defineObjectType({
  id: "poly",
  name: "Poly",
  properties: [prop("id", "string", { required: true, primary: true }), prop("ref", "string")],
  links: [link("targets", [Building, Room])],
})

const TypeWithWildcardLink = defineObjectType({
  id: "wild",
  name: "Wild",
  properties: [prop("id", "string", { required: true, primary: true }), prop("ref", "string")],
  links: [link.any("anything")],
})

// ── defineProjection ─────────────────────────────────────────

describe("defineProjection", () => {
  test("builds correct ObjectProjectionDefinition", () => {
    const result = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })

    expect(result._tag).toBe("ObjectProjectionDefinition")
    expect(result.id).toBe("room-proj")
    expect(result.objectTypeId).toBe("room")
    expect(result.datasetId).toBe("canonical.rooms")
    expect(result.properties).toEqual({ id: "room_id", name: "room_name" })
    expect(result.links).toEqual({})
    expect(result.conflictResolution).toEqual({ strategy: "editsWin" })
  })

  test("configures most-recent source/edit conflict resolution", () => {
    const result = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
      .resolveConflicts({ strategy: "mostRecent", sourceTimestamp: "updated_at" })

    expect(result.conflictResolution).toEqual({
      strategy: "mostRecent",
      sourceTimestamp: "updated_at",
    })
  })

  test("builds definition with FK links", () => {
    const result = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name", buildingRef: "building_id" })
      .withLinks({
        inBuilding: fromForeignKey({
          link: Room.l.inBuilding,
          sourceProperty: Room.p.buildingRef,
          target: Building,
        }),
      })

    expect(result._tag).toBe("ObjectProjectionDefinition")
    expect(result.links).toEqual({
      inBuilding: {
        linkId: "inBuilding",
        sourcePropertyId: "buildingRef",
        targetObjectTypeId: "building",
      },
    })
  })

  test("builds FK links from dataset fields, via fromForeignKey or an inline descriptor", () => {
    const base = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
    const expected = {
      inBuilding: {
        linkId: "inBuilding",
        sourceField: "building_id",
        targetObjectTypeId: "building",
      },
    }
    const descriptor = {
      link: Room.l.inBuilding,
      sourceField: "building_id",
      target: Building,
    } as const

    expect(base.withLinks({ inBuilding: fromForeignKey(descriptor) }).links).toEqual(expected)
    expect(base.withLinks({ inBuilding: descriptor }).links).toEqual(expected)
  })

  test("withLinks() does not mutate the intermediate", () => {
    const intermediate = defineProjection("p", Room)
      .fromDataset(genericDataset)
      .properties({ id: "col", buildingRef: "ref" })

    const fkDescriptor = fromForeignKey({
      link: Room.l.inBuilding,
      sourceProperty: Room.p.buildingRef,
      target: Building,
    })

    // Call .withLinks() to produce a new finalized definition
    const withLinks = intermediate.withLinks({ inBuilding: fkDescriptor })

    // The finalized definition has the FK links
    expect(withLinks.links).toEqual({ inBuilding: fkDescriptor })

    // The intermediate still has links: {}
    expect(intermediate.links).toEqual({})

    // Calling .withLinks() again produces another independent definition
    const withLinks2 = intermediate.withLinks({ inBuilding: fkDescriptor })
    expect(withLinks2).not.toBe(withLinks)
    expect(withLinks2.links).toEqual(withLinks.links)
  })
})

// ── Link projection ─────────────────────────────────────

describe("defineProjection — link target", () => {
  test("builds correct LinkProjectionDefinition", () => {
    const result = defineProjection("room-sensor-links", Room.l.hasSensors)
      .fromDataset(roomSensorsDataset)
      .sourceField("room_id")
      .targetField("sensor_id")

    expect(result._tag).toBe("LinkProjectionDefinition")
    expect(result.id).toBe("room-sensor-links")
    expect(result.linkId).toBe("hasSensors")
    expect(result.sourceObjectTypeId).toBe("room")
    expect(result.targetObjectTypeId).toBe("sensor")
    expect(result.datasetId).toBe("join.room-sensors")
    expect(result.sourceField).toBe("room_id")
    expect(result.targetField).toBe("sensor_id")
  })
})

// ── Telemetry projection ────────────────────────────────

describe("defineProjection — telemetry target", () => {
  test("builds correct TelemetryProjectionDefinition, with an optional unit field", () => {
    const points = { objectId: "room_id", at: "observed_at", value: "temperature" } as const
    const result = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points(points)

    expect(result._tag).toBe("TelemetryProjectionDefinition")
    expect(result.id).toBe("room-temperatures")
    expect(result.objectTypeId).toBe("room")
    expect(result.datasetId).toBe("canonical.room-readings")
    expect(result.objectIdField).toBe("room_id")
    expect(result.atField).toBe("observed_at")
    expect(result.properties).toEqual({ temperature: { valueField: "temperature" } })

    const withUnit = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points({ ...points, unit: "unit" })
    expect(withUnit.properties).toEqual({
      temperature: { valueField: "temperature", unitField: "unit" },
    })
  })

  test("builds one canonical definition for multiple telemetry properties", () => {
    const result = defineProjection("room-readings", Room)
      .fromDataset(roomReadingsDataset)
      .points({
        objectId: "room_id",
        at: "observed_at",
        properties: {
          temperature: { value: "temperature", unit: "unit" },
          humidity: "humidity",
        },
      })

    expect(result).toEqual({
      _tag: "TelemetryProjectionDefinition",
      id: "room-readings",
      objectTypeId: "room",
      datasetId: "canonical.room-readings",
      objectIdField: "room_id",
      atField: "observed_at",
      properties: {
        temperature: { valueField: "temperature", unitField: "unit" },
        humidity: { valueField: "humidity" },
      },
    })
  })
})

// ── Validation ───────────────────────────────────────────────

const invalidDataset = { kind: "dataset", id: "  ", schema: { columns: [] } } as never
const roomProjection = () =>
  defineProjection("p", Room).fromDataset(genericDataset).properties({ id: "col" })
const sensorLinks = () => defineProjection("lp", Room.l.hasSensors).fromDataset(genericDataset)
const temperaturePoints = (points: Record<string, string>) =>
  defineProjection("tp", Room.p.temperature)
    .fromDataset(roomReadingsDataset)
    .points(points as never)
const groupedPoints = (properties: Record<string, unknown>) =>
  defineProjection("grouped", Room)
    .fromDataset(roomReadingsDataset)
    .points({ objectId: "room_id", at: "observed_at", properties } as never)
const linkMapping = (sourcePropertyId: string, linkId = "inBuilding") =>
  ({ inBuilding: { linkId, sourcePropertyId, targetObjectTypeId: "building" } }) as never

test.each([
  [
    "empty object projection id",
    () => defineProjection("  ", Room),
    "Projection id must not be empty",
  ],
  [
    "empty object dataset id",
    () => defineProjection("p", Room).fromDataset(invalidDataset),
    "Projection dataset id must not be empty",
  ],
  [
    "unknown property id",
    () =>
      defineProjection("p", Room)
        .fromDataset(genericDataset)
        .properties({ id: "col", unknownProp: "col" } as never),
    "unknownProp",
  ],
  [
    "missing primary property",
    () => defineProjection("p", Room).fromDataset(genericDataset).properties({ name: "col" }),
    "Primary property 'id' of object type 'room' must be included",
  ],
  [
    "unknown link id",
    () =>
      roomProjection().withLinks({
        unknownLink: { linkId: "unknownLink", sourcePropertyId: "id", targetObjectTypeId: "x" },
      } as never),
    "unknownLink",
  ],
  [
    "link key / descriptor linkId mismatch",
    () =>
      defineProjection("p", Room)
        .fromDataset(genericDataset)
        .properties({ id: "col", buildingRef: "ref" })
        .withLinks(linkMapping("buildingRef", "wrongId")),
    "wrongId",
  ],
  [
    "link source property not on the type",
    () => roomProjection().withLinks(linkMapping("nonExistent")),
    "nonExistent",
  ],
  [
    // buildingRef exists on Room but is not in the property mapping
    "link source property not in the property mapping",
    () => roomProjection().withLinks(linkMapping("buildingRef")),
    "buildingRef",
  ],
  [
    "fromForeignKey on a polymorphic link",
    () =>
      fromForeignKey({
        link: TypeWithPolymorphicLink.l.targets as never,
        sourceProperty: TypeWithPolymorphicLink.p.ref as never,
        target: Building,
      }),
    "polymorphic",
  ],
  [
    "fromForeignKey on a wildcard link",
    () =>
      fromForeignKey({
        link: TypeWithWildcardLink.l.anything as never,
        sourceProperty: TypeWithWildcardLink.p.ref as never,
        target: Building,
      }),
    "wildcard",
  ],
  [
    "empty link projection id",
    () => defineProjection("  ", Room.l.hasSensors),
    "Projection id must not be empty",
  ],
  [
    "empty link dataset id",
    () => defineProjection("lp", Room.l.hasSensors).fromDataset(invalidDataset),
    "Projection dataset id must not be empty",
  ],
  [
    "empty link source field",
    () => sensorLinks().sourceField("  " as never),
    "Projection source field must not be empty",
  ],
  [
    "empty link target field",
    () =>
      sensorLinks()
        .sourceField("a")
        .targetField("  " as never),
    "Projection target field must not be empty",
  ],
  [
    "polymorphic link token",
    () => defineProjection("lp", TypeWithPolymorphicLink.l.targets as never),
    "polymorphic",
  ],
  [
    "wildcard link token",
    () => defineProjection("lp", TypeWithWildcardLink.l.anything as never),
    "wildcard",
  ],
  [
    "static property token",
    () => defineProjection("room-names", Room.p.name as never),
    "must be telemetry-enabled",
  ],
  [
    "empty telemetry projection id",
    () => defineProjection("  ", Room.p.temperature),
    "Projection id must not be empty",
  ],
  [
    "empty telemetry dataset id",
    () => defineProjection("tp", Room.p.temperature).fromDataset(invalidDataset),
    "Projection dataset id must not be empty",
  ],
  [
    "point mapping without at",
    () => temperaturePoints({ objectId: "room_id", value: "temperature" }),
    "requires at",
  ],
  [
    "unknown point mapping key",
    () =>
      temperaturePoints({
        objectId: "room_id",
        at: "observed_at",
        value: "temperature",
        extra: "room_id",
      }),
    "unknown key 'extra'",
  ],
  ["grouped mapping without properties", () => groupedPoints({}), "requires at least one property"],
  [
    "grouped mapping of a static property",
    () => groupedPoints({ name: "temperature" }),
    "must be telemetry-enabled",
  ],
  [
    "grouped mapping of an unknown property",
    () => groupedPoints({ missing: "temperature" }),
    "does not exist",
  ],
  [
    "grouped property descriptor with an unknown key",
    () => groupedPoints({ temperature: { value: "temperature", extra: "unit" } }),
    "unknown key 'extra'",
  ],
] as const)("rejects %s", (_case, define, message) => {
  expect(define).toThrow(ProjectionValidationError)
  expect(define).toThrow(message)
})

// ── Type guards ──────────────────────────────────────────────

describe("type guards", () => {
  const objectDef = roomProjection()

  const linkDef = defineProjection("lp", Room.l.hasSensors)
    .fromDataset(genericDataset)
    .sourceField("a")
    .targetField("b")

  const telemetryDef = defineProjection("tp", Room.p.temperature)
    .fromDataset(roomReadingsDataset)
    .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

  test("each guard accepts its own kind and rejects other kinds and tag-only lookalikes", () => {
    expect(isObjectProjectionDefinition(objectDef)).toBe(true)
    expect(isObjectProjectionDefinition(linkDef)).toBe(false)
    expect(isObjectProjectionDefinition({ _tag: "ObjectProjectionDefinition" })).toBe(false)
    expect(isObjectProjectionDefinition(null)).toBe(false)
    expect(isObjectProjectionDefinition(undefined)).toBe(false)

    expect(isLinkProjectionDefinition(linkDef)).toBe(true)
    expect(isLinkProjectionDefinition(objectDef)).toBe(false)
    expect(isLinkProjectionDefinition({ _tag: "LinkProjectionDefinition" })).toBe(false)

    expect(isTelemetryProjectionDefinition(telemetryDef)).toBe(true)
    expect(isTelemetryProjectionDefinition(objectDef)).toBe(false)
    expect(isTelemetryProjectionDefinition(linkDef)).toBe(false)
    expect(isTelemetryProjectionDefinition({ _tag: "TelemetryProjectionDefinition" })).toBe(false)

    expect(isProjectionDefinition(objectDef)).toBe(true)
    expect(isProjectionDefinition(linkDef)).toBe(true)
    expect(isProjectionDefinition(telemetryDef)).toBe(true)
    expect(isProjectionDefinition({})).toBe(false)
    expect(isProjectionDefinition("string")).toBe(false)
  })

  test("categorizeProjections groups telemetry definitions separately", () => {
    const categorized = categorizeProjections([objectDef, linkDef, telemetryDef])

    expect(categorized.objectProjections).toEqual([objectDef])
    expect(categorized.linkProjections).toEqual([linkDef])
    expect(categorized.telemetryProjections).toEqual([telemetryDef])
  })
})
