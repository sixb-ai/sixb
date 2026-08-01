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
  })

  test("rejects empty id", () => {
    expect(() => defineProjection("  ", Room)).toThrow(ProjectionValidationError)
    expect(() => defineProjection("  ", Room)).toThrow("Projection id must not be empty")
  })

  test("rejects empty dataset id", () => {
    const invalidDataset = { kind: "dataset", id: "  ", schema: { columns: [] } } as never
    expect(() => defineProjection("p", Room).fromDataset(invalidDataset)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("p", Room).fromDataset(invalidDataset)).toThrow(
      "Projection dataset id must not be empty"
    )
  })

  test("rejects unknown property id in mapping", () => {
    expect(() =>
      defineProjection("p", Room)
        .fromDataset(genericDataset)
        .properties({ id: "col", unknownProp: "col" } as never)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("p", Room)
        .fromDataset(genericDataset)
        .properties({ id: "col", unknownProp: "col" } as never)
    ).toThrow("unknownProp")
  })

  test("rejects missing primary in mapping", () => {
    expect(() =>
      defineProjection("p", Room).fromDataset(genericDataset).properties({ name: "col" })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("p", Room).fromDataset(genericDataset).properties({ name: "col" })
    ).toThrow("id")
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

  test("builds definition with FK links from dataset fields", () => {
    const result = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
      .withLinks({
        inBuilding: fromForeignKey({
          link: Room.l.inBuilding,
          sourceField: "building_id",
          target: Building,
        }),
      })

    expect(result.links).toEqual({
      inBuilding: {
        linkId: "inBuilding",
        sourceField: "building_id",
        targetObjectTypeId: "building",
      },
    })
  })

  test("builds definition with typed inline FK links from dataset fields", () => {
    const result = defineProjection("room-proj", Room)
      .fromDataset(canonicalRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
      .withLinks({
        inBuilding: {
          link: Room.l.inBuilding,
          sourceField: "building_id",
          target: Building,
        },
      })

    expect(result.links).toEqual({
      inBuilding: {
        linkId: "inBuilding",
        sourceField: "building_id",
        targetObjectTypeId: "building",
      },
    })
  })

  test("rejects unknown link id in withLinks mapping", () => {
    const base = defineProjection("p", Room).fromDataset(genericDataset).properties({ id: "col" })

    expect(() =>
      base.withLinks({
        unknownLink: {
          linkId: "unknownLink",
          sourcePropertyId: "id",
          targetObjectTypeId: "x",
        },
      } as Record<string, { linkId: string; sourcePropertyId: string; targetObjectTypeId: string }>)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      base.withLinks({
        unknownLink: {
          linkId: "unknownLink",
          sourcePropertyId: "id",
          targetObjectTypeId: "x",
        },
      } as Record<string, { linkId: string; sourcePropertyId: string; targetObjectTypeId: string }>)
    ).toThrow("unknownLink")
  })

  test("rejects link id / descriptor.linkId mismatch", () => {
    const base = defineProjection("p", Room)
      .fromDataset(genericDataset)
      .properties({ id: "col", buildingRef: "ref" })

    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "wrongId",
          sourcePropertyId: "buildingRef",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "wrongId",
          sourcePropertyId: "buildingRef",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow("wrongId")
  })

  test("rejects link with source property not on type", () => {
    const base = defineProjection("p", Room).fromDataset(genericDataset).properties({ id: "col" })

    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "inBuilding",
          sourcePropertyId: "nonExistent",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "inBuilding",
          sourcePropertyId: "nonExistent",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow("nonExistent")
  })

  test("rejects link with source property not in property mapping", () => {
    // buildingRef exists on Room but is not in the property mapping
    const base = defineProjection("p", Room).fromDataset(genericDataset).properties({ id: "col" })

    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "inBuilding",
          sourcePropertyId: "buildingRef",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      base.withLinks({
        inBuilding: {
          linkId: "inBuilding",
          sourcePropertyId: "buildingRef",
          targetObjectTypeId: "building",
        },
      })
    ).toThrow("buildingRef")
  })

  test("properties() result is a valid ObjectProjectionDefinition", () => {
    const result = defineProjection("p", Room).fromDataset(genericDataset).properties({ id: "col" })

    expect(isObjectProjectionDefinition(result)).toBe(true)
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

// ── fromForeignKey ───────────────────────────────────────────

describe("fromForeignKey", () => {
  test("builds correct ForeignKeyDescriptor", () => {
    const descriptor = fromForeignKey({
      link: Room.l.inBuilding,
      sourceProperty: Room.p.buildingRef,
      target: Building,
    })

    expect(descriptor).toEqual({
      linkId: "inBuilding",
      sourcePropertyId: "buildingRef",
      targetObjectTypeId: "building",
    })
  })

  test("rejects polymorphic link (array target)", () => {
    expect(() =>
      fromForeignKey({
        link: TypeWithPolymorphicLink.l.targets as never,
        sourceProperty: TypeWithPolymorphicLink.p.ref as never,
        target: Building,
      })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      fromForeignKey({
        link: TypeWithPolymorphicLink.l.targets as never,
        sourceProperty: TypeWithPolymorphicLink.p.ref as never,
        target: Building,
      })
    ).toThrow("polymorphic")
  })

  test("rejects wildcard link", () => {
    expect(() =>
      fromForeignKey({
        link: TypeWithWildcardLink.l.anything as never,
        sourceProperty: TypeWithWildcardLink.p.ref as never,
        target: Building,
      })
    ).toThrow(ProjectionValidationError)
    expect(() =>
      fromForeignKey({
        link: TypeWithWildcardLink.l.anything as never,
        sourceProperty: TypeWithWildcardLink.p.ref as never,
        target: Building,
      })
    ).toThrow("wildcard")
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

  test("rejects empty id", () => {
    expect(() => defineProjection("  ", Room.l.hasSensors)).toThrow(ProjectionValidationError)
    expect(() => defineProjection("  ", Room.l.hasSensors)).toThrow(
      "Projection id must not be empty"
    )
  })

  test("rejects empty dataset id", () => {
    const invalidDataset = { kind: "dataset", id: "  ", schema: { columns: [] } } as never
    expect(() => defineProjection("lp", Room.l.hasSensors).fromDataset(invalidDataset)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("lp", Room.l.hasSensors).fromDataset(invalidDataset)).toThrow(
      "Projection dataset id must not be empty"
    )
  })

  test("rejects empty source field", () => {
    expect(() =>
      defineProjection("lp", Room.l.hasSensors)
        .fromDataset(genericDataset)
        .sourceField("  " as never)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("lp", Room.l.hasSensors)
        .fromDataset(genericDataset)
        .sourceField("  " as never)
    ).toThrow("Projection source field must not be empty")
  })

  test("rejects empty target field", () => {
    expect(() =>
      defineProjection("lp", Room.l.hasSensors)
        .fromDataset(genericDataset)
        .sourceField("a")
        .targetField("  " as never)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("lp", Room.l.hasSensors)
        .fromDataset(genericDataset)
        .sourceField("a")
        .targetField("  " as never)
    ).toThrow("Projection target field must not be empty")
  })

  test("rejects polymorphic link token", () => {
    expect(() => defineProjection("lp", TypeWithPolymorphicLink.l.targets as never)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("lp", TypeWithPolymorphicLink.l.targets as never)).toThrow(
      "polymorphic"
    )
  })

  test("rejects wildcard link token", () => {
    expect(() => defineProjection("lp", TypeWithWildcardLink.l.anything as never)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("lp", TypeWithWildcardLink.l.anything as never)).toThrow(
      "wildcard"
    )
  })
})

// ── Telemetry projection ────────────────────────────────

describe("defineProjection — telemetry target", () => {
  test("builds correct TelemetryProjectionDefinition", () => {
    const result = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points({
        objectId: "room_id",
        at: "observed_at",
        value: "temperature",
      })

    expect(result._tag).toBe("TelemetryProjectionDefinition")
    expect(result.id).toBe("room-temperatures")
    expect(result.objectTypeId).toBe("room")
    expect(result.propertyId).toBe("temperature")
    expect(result.datasetId).toBe("canonical.room-readings")
    expect(result.objectIdField).toBe("room_id")
    expect(result.atField).toBe("observed_at")
    expect(result.valueField).toBe("temperature")
    expect(result.unitField).toBeUndefined()
  })

  test("builds definition with optional unit field", () => {
    const result = defineProjection("room-temperatures", Room.p.temperature)
      .fromDataset(roomReadingsDataset)
      .points({
        objectId: "room_id",
        at: "observed_at",
        value: "temperature",
        unit: "unit",
      })

    expect(result.unitField).toBe("unit")
  })

  test("rejects static property token", () => {
    expect(() => defineProjection("room-names", Room.p.name as never)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("room-names", Room.p.name as never)).toThrow(
      "must be telemetry-enabled"
    )
  })

  test("rejects empty id", () => {
    expect(() => defineProjection("  ", Room.p.temperature)).toThrow(ProjectionValidationError)
    expect(() => defineProjection("  ", Room.p.temperature)).toThrow(
      "Projection id must not be empty"
    )
  })

  test("rejects empty dataset id", () => {
    const invalidDataset = { kind: "dataset", id: "  ", schema: { columns: [] } } as never
    expect(() => defineProjection("tp", Room.p.temperature).fromDataset(invalidDataset)).toThrow(
      ProjectionValidationError
    )
    expect(() => defineProjection("tp", Room.p.temperature).fromDataset(invalidDataset)).toThrow(
      "Projection dataset id must not be empty"
    )
  })

  test("rejects missing required point mapping fields", () => {
    expect(() =>
      defineProjection("tp", Room.p.temperature)
        .fromDataset(roomReadingsDataset)
        .points({ objectId: "room_id", value: "temperature" } as never)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("tp", Room.p.temperature)
        .fromDataset(roomReadingsDataset)
        .points({ objectId: "room_id", value: "temperature" } as never)
    ).toThrow("requires at")
  })

  test("rejects unknown point mapping keys", () => {
    expect(() =>
      defineProjection("tp", Room.p.temperature)
        .fromDataset(roomReadingsDataset)
        .points({
          objectId: "room_id",
          at: "observed_at",
          value: "temperature",
          extra: "room_id",
        } as never)
    ).toThrow(ProjectionValidationError)
    expect(() =>
      defineProjection("tp", Room.p.temperature)
        .fromDataset(roomReadingsDataset)
        .points({
          objectId: "room_id",
          at: "observed_at",
          value: "temperature",
          extra: "room_id",
        } as never)
    ).toThrow("unknown key 'extra'")
  })
})

// ── Type guards ──────────────────────────────────────────────

describe("type guards", () => {
  const objectDef = defineProjection("p", Room)
    .fromDataset(genericDataset)
    .properties({ id: "col" })

  const linkDef = defineProjection("lp", Room.l.hasSensors)
    .fromDataset(genericDataset)
    .sourceField("a")
    .targetField("b")

  const telemetryDef = defineProjection("tp", Room.p.temperature)
    .fromDataset(roomReadingsDataset)
    .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

  test("isObjectProjectionDefinition — positive", () => {
    expect(isObjectProjectionDefinition(objectDef)).toBe(true)
  })

  test("isObjectProjectionDefinition — negative", () => {
    expect(isObjectProjectionDefinition(linkDef)).toBe(false)
    expect(isObjectProjectionDefinition({ _tag: "ObjectProjectionDefinition" })).toBe(false)
    expect(isObjectProjectionDefinition(null)).toBe(false)
    expect(isObjectProjectionDefinition(undefined)).toBe(false)
  })

  test("isLinkProjectionDefinition — positive", () => {
    expect(isLinkProjectionDefinition(linkDef)).toBe(true)
  })

  test("isLinkProjectionDefinition — negative", () => {
    expect(isLinkProjectionDefinition(objectDef)).toBe(false)
    expect(isLinkProjectionDefinition({ _tag: "LinkProjectionDefinition" })).toBe(false)
  })

  test("isTelemetryProjectionDefinition — positive", () => {
    expect(isTelemetryProjectionDefinition(telemetryDef)).toBe(true)
  })

  test("isTelemetryProjectionDefinition — negative", () => {
    expect(isTelemetryProjectionDefinition(objectDef)).toBe(false)
    expect(isTelemetryProjectionDefinition(linkDef)).toBe(false)
    expect(isTelemetryProjectionDefinition({ _tag: "TelemetryProjectionDefinition" })).toBe(false)
  })

  test("isProjectionDefinition", () => {
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
