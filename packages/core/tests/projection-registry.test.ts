import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  defineTelemetryProjection,
  defineValueType,
  link,
  OntologyRegistry,
  ProjectionValidationError,
  prop,
  type ValueType,
  valueTypeRef,
} from "../src"
import {
  computeOntologyRevision,
  computeProjectionRevision,
  ProjectionRegistry,
} from "../src/materializer"

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor display name",
  properties: [prop("id", "string", { primary: true, required: true })],
})
const Room = defineObjectType({
  id: "Room",
  name: "Room display name",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("name", "string"),
    prop("sensorId", "string"),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
  links: [link("hasSensor", Sensor, { cardinality: "one" })],
})
const rooms = defineDataset("rooms", {
  schema: [col("room_name", "string"), col("room_id", "string"), col("sensor_id", "string")],
})
const roomSensors = defineDataset("room-sensors", {
  schema: [col("sensor_id", "string"), col("room_id", "string")],
})
const readings = defineDataset("readings", {
  schema: [col("value", "float64"), col("observed_at", "timestamp"), col("room_id", "string")],
})

function registry(): OntologyRegistry {
  return new OntologyRegistry({ sources: [Room, Sensor] })
}

function datasets(...definitions: readonly ReturnType<typeof defineDataset>[]) {
  return new Map(definitions.map((definition) => [definition.id, definition] as const))
}

describe("projection registry", () => {
  test("returns immutable source and telemetry records with isolated resolution", () => {
    const roomProjection = defineProjection("rooms", Room)
      .fromDataset(rooms)
      .properties({ id: "room_id", name: "room_name" })
    const temperatureProjection = defineTelemetryProjection("temperatures", Room.p.temperature)
      .fromDataset(readings)
      .points({ objectId: "room_id", at: "observed_at", value: "value" })
    const projectionRegistry = new ProjectionRegistry({
      projections: [roomProjection, temperatureProjection],
      ontology: registry(),
      datasetsById: datasets(rooms, readings),
    })

    const resolved = projectionRegistry.resolveSource("rooms")
    expect(resolved.ownership.objects).toEqual([
      { objectTypeId: "Room", existence: true, propertyIds: ["name"] },
    ])
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.definition)).toBe(true)
    expect(Object.isFrozen(resolved.ownership.objects[0].propertyIds)).toBe(true)
    expect(projectionRegistry.resolveTelemetry("temperatures").definition.propertyId).toBe(
      "temperature"
    )
    expect(() => projectionRegistry.resolveSource("temperatures")).toThrow("telemetry-only")
    expect(() => projectionRegistry.resolveTelemetry("rooms")).toThrow(
      "does not own a telemetry source"
    )
  })

  test("keeps ontology revisions stable across non-semantic ordering and metadata", () => {
    const reorderedRoom = defineObjectType({
      id: "Room",
      name: "Renamed room",
      description: "Display-only description",
      properties: [
        prop("temperature", "double", { mode: "telemetry" }),
        prop("sensorId", "string"),
        prop("name", "string"),
        prop("id", "string", { primary: true, required: true }),
      ],
      links: [link("hasSensor", Sensor, { cardinality: "one" })],
    })
    const firstRegistry = registry()
    const secondRegistry = new OntologyRegistry({ sources: [Sensor, reorderedRoom] })
    expect(computeOntologyRevision(firstRegistry)).toBe(computeOntologyRevision(secondRegistry))
  })

  test("hashes object, link, and telemetry mapping semantics without runtime identity", () => {
    const objectProjection = defineProjection("rooms", Room)
      .fromDataset(rooms)
      .properties({ id: "room_id", name: "room_name" })
    const linkProjection = defineLinkProjection("room-sensors", Room.l.hasSensor)
      .fromDataset(roomSensors)
      .sourceField("room_id")
      .targetField("sensor_id")
    const telemetryProjection = defineTelemetryProjection("temperatures", Room.p.temperature)
      .fromDataset(readings)
      .points({ objectId: "room_id", at: "observed_at", value: "value" })

    const renamedRooms = defineDataset("renamed-rooms-dataset", {
      description: "Display-only description",
      schema: [col("sensor_id", "string"), col("room_name", "string"), col("room_id", "string")],
    })
    const renamedLinks = defineDataset("renamed-links-dataset", {
      schema: [col("room_id", "string"), col("sensor_id", "string")],
    })
    const renamedReadings = defineDataset("renamed-readings-dataset", {
      schema: [col("observed_at", "timestamp"), col("room_id", "string"), col("value", "float64")],
    })

    expect(computeProjectionRevision(objectProjection, rooms)).toBe(
      computeProjectionRevision(
        {
          ...objectProjection,
          id: "renamed-object-projection",
          datasetId: renamedRooms.id,
          properties: { name: "room_name", id: "room_id" },
        },
        renamedRooms
      )
    )
    expect(computeProjectionRevision(linkProjection, roomSensors)).toBe(
      computeProjectionRevision(
        {
          ...linkProjection,
          id: "renamed-link-projection",
          datasetId: renamedLinks.id,
        },
        renamedLinks
      )
    )
    expect(computeProjectionRevision(telemetryProjection, readings)).toBe(
      computeProjectionRevision(
        {
          ...telemetryProjection,
          id: "renamed-telemetry-projection",
          datasetId: renamedReadings.id,
        },
        renamedReadings
      )
    )

    expect(
      computeProjectionRevision(
        { ...objectProjection, properties: { id: "room_id", name: "room_id" } },
        rooms
      )
    ).not.toBe(computeProjectionRevision(objectProjection, rooms))
    expect(
      computeProjectionRevision(
        { ...linkProjection, sourceField: "sensor_id", targetField: "room_id" },
        roomSensors
      )
    ).not.toBe(computeProjectionRevision(linkProjection, roomSensors))
    expect(
      computeProjectionRevision(
        { ...telemetryProjection, objectIdField: "observed_at", atField: "room_id" },
        readings
      )
    ).not.toBe(computeProjectionRevision(telemetryProjection, readings))

    const nullableRooms = defineDataset("rooms", {
      schema: [
        col("room_name", "string", { nullable: true }),
        col("room_id", "string"),
        col("sensor_id", "string"),
      ],
    })
    expect(computeProjectionRevision(objectProjection, nullableRooms)).not.toBe(
      computeProjectionRevision(objectProjection, rooms)
    )
  })

  test("clones resolved definitions field by field", () => {
    const objectProjection = {
      ...defineProjection("rooms", Room)
        .fromDataset(rooms)
        .properties({ id: "room_id", name: "room_name" })
        .withLinks({
          hasSensor: {
            linkId: "hasSensor",
            sourceField: "sensor_id",
            targetObjectTypeId: "Sensor",
            ignoredDescriptorField: true,
          } as never,
        }),
      ignoredDefinitionField: true,
    }
    const linkProjection = {
      ...defineLinkProjection("room-sensors", Room.l.hasSensor)
        .fromDataset(roomSensors)
        .sourceField("room_id")
        .targetField("sensor_id"),
      ignoredDefinitionField: true,
    }
    const telemetryProjection = {
      ...defineTelemetryProjection("temperatures", Room.p.temperature)
        .fromDataset(readings)
        .points({ objectId: "room_id", at: "observed_at", value: "value" }),
      ignoredDefinitionField: true,
    }
    const projectionRegistry = new ProjectionRegistry({
      projections: [objectProjection, telemetryProjection],
      ontology: registry(),
      datasetsById: datasets(rooms, readings),
    })

    const resolvedObject = projectionRegistry.resolveSource("rooms").definition
    if (resolvedObject._tag !== "ObjectProjectionDefinition") throw new Error("unexpected kind")
    expect(Object.keys(resolvedObject)).toEqual([
      "_tag",
      "id",
      "objectTypeId",
      "datasetId",
      "properties",
      "links",
    ])
    expect(Object.keys(resolvedObject.links.hasSensor)).toEqual([
      "linkId",
      "sourceField",
      "targetObjectTypeId",
    ])

    const linkRegistry = new ProjectionRegistry({
      projections: [linkProjection],
      ontology: registry(),
      datasetsById: datasets(roomSensors),
    })
    const resolvedLink = linkRegistry.resolveSource("room-sensors").definition
    expect(Object.keys(resolvedLink)).not.toContain("ignoredDefinitionField")
    const resolvedTelemetry = projectionRegistry.resolveTelemetry("temperatures").definition
    expect(Object.keys(resolvedTelemetry)).not.toContain("ignoredDefinitionField")
  })

  test("hashes only directly and transitively referenced value types", () => {
    const Leaf = defineValueType({ id: "Leaf", name: "Leaf", schema: "string" })
    const Container = defineValueType({
      id: "Container",
      name: "Container",
      schema: {
        type: "object",
        properties: { leaf: { schema: valueTypeRef("Leaf"), required: true } },
      },
    })
    const Unused = defineValueType({ id: "Unused", name: "Unused", schema: "boolean" })
    const ReferencingObject = defineObjectType({
      id: "ReferencingObject",
      name: "Referencing object",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("container", valueTypeRef("Container")),
      ],
    })
    const ontology = (valueTypes: readonly ValueType[]) =>
      new OntologyRegistry({
        sources: [
          {
            id: "revision-test",
            version: "1",
            objectTypes: [ReferencingObject],
            valueTypes,
          },
        ],
      })

    const baseline = computeOntologyRevision(ontology([Leaf, Container, Unused]))
    const changedUnused = defineValueType({
      id: "Unused",
      name: "Changed unused",
      schema: "integer",
    })
    expect(computeOntologyRevision(ontology([Leaf, Container, changedUnused]))).toBe(baseline)

    const changedLeaf = defineValueType({ id: "Leaf", name: "Leaf", schema: "integer" })
    expect(computeOntologyRevision(ontology([changedLeaf, Container, Unused]))).not.toBe(baseline)

    const changedContainer = defineValueType({
      id: "Container",
      name: "Container",
      schema: { type: "array", items: valueTypeRef("Leaf") },
    })
    expect(computeOntologyRevision(ontology([Leaf, changedContainer, Unused]))).not.toBe(baseline)
  })

  test("rejects object existence and link scope ownership overlaps", () => {
    const first = defineProjection("rooms-a", Room)
      .fromDataset(rooms)
      .properties({ id: "room_id", name: "room_name" })
    const second = defineProjection("rooms-b", Room)
      .fromDataset(rooms)
      .properties({ id: "room_id" })
    expect(
      () =>
        new ProjectionRegistry({
          projections: [first, second],
          ontology: registry(),
          datasetsById: datasets(rooms),
        })
    ).toThrow("overlaps object type 'Room' existence")

    const fkProjection = defineProjection("rooms-with-sensor", Room)
      .fromDataset(rooms)
      .properties({ id: "room_id" })
      .withLinks({
        hasSensor: {
          link: Room.l.hasSensor,
          sourceField: "sensor_id",
          target: Sensor,
        },
      })
    const linkProjection = defineLinkProjection("room-sensors", Room.l.hasSensor)
      .fromDataset(roomSensors)
      .sourceField("room_id")
      .targetField("sensor_id")
    expect(
      () =>
        new ProjectionRegistry({
          projections: [fkProjection, linkProjection],
          ontology: registry(),
          datasetsById: datasets(rooms, roomSensors),
        })
    ).toThrow("overlaps link scope 'Room.hasSensor'")
  })

  test("isolates telemetry authority from source mappings and required properties", () => {
    const invalidSourceProjection = {
      _tag: "ObjectProjectionDefinition" as const,
      id: "invalid-source",
      objectTypeId: "Room",
      datasetId: "rooms",
      properties: { id: "room_id", temperature: "room_name" },
      links: {},
    }
    expect(
      () =>
        new ProjectionRegistry({
          projections: [invalidSourceProjection],
          ontology: registry(),
          datasetsById: datasets(rooms),
        })
    ).toThrow("source mappings cannot own telemetry property")

    const RequiredTelemetry = defineObjectType({
      id: "RequiredTelemetry",
      name: "Required telemetry",
      properties: [
        prop("id", "string", { primary: true, required: true }),
        prop("reading", "double", { mode: "telemetry", required: true }),
      ],
    })
    expect(
      () =>
        new ProjectionRegistry({
          projections: [],
          ontology: new OntologyRegistry({ sources: [RequiredTelemetry] }),
          datasetsById: new Map(),
        })
    ).toThrow(ProjectionValidationError)
    expect(
      () =>
        new ProjectionRegistry({
          projections: [],
          ontology: new OntologyRegistry({ sources: [RequiredTelemetry] }),
          datasetsById: new Map(),
        })
    ).toThrow("cannot be required")
  })
})
