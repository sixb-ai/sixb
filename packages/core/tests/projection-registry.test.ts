import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineValueType,
  link,
  OntologyRegistry,
  prop,
  type ValueType,
  valueTypeRef,
} from "../src"
import type { ProjectionMaterializationIdentity } from "../src/materialization"
import {
  computeOntologyRevision,
  computeProjectionRevision,
  ProjectionRegistry,
} from "../src/materializer"
import {
  createProjectionRunId,
  getProjectionDispatchDescriptors,
  registerProjectionRegistry,
} from "../src/projections/internal"

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
    const temperatureProjection = defineProjection("temperatures", Room.p.temperature)
      .fromDataset(readings)
      .points({ objectId: "room_id", at: "observed_at", value: "value" })
    const projectionRegistry = new ProjectionRegistry({
      projections: [roomProjection, temperatureProjection],
      ontology: registry(),
      datasetsById: datasets(rooms, readings),
    })

    const resolved = projectionRegistry.resolveSource("rooms")
    const objectProjections = projectionRegistry.listObjectProjections()
    const telemetryProjections = projectionRegistry.listTelemetryProjections()
    expect(Object.isFrozen(objectProjections)).toBe(true)
    expect(Object.isFrozen(telemetryProjections)).toBe(true)
    expect(projectionRegistry.listLinkProjections()).toEqual([])
    expect(projectionRegistry.getProjectionById("rooms")).toBe(objectProjections[0])
    expect(projectionRegistry.getProjectionById("temperatures")).toBe(telemetryProjections[0])
    expect(resolved.definition).toBe(objectProjections[0])
    expect(projectionRegistry.resolveTelemetry("temperatures").definition).toBe(
      telemetryProjections[0]
    )
    expect(projectionRegistry.getProjectionById("missing")).toBeNull()
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

    const descriptors = projectionRegistry.getDispatchDescriptors()
    expect(Object.isFrozen(descriptors)).toBe(true)
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0]).toMatchObject({
      projectionId: "rooms",
      projectionKind: "object",
      protocol: "replacement",
      datasetId: "rooms",
      ontologyRevision: projectionRegistry.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
    })
    expect(Object.isFrozen(descriptors[0])).toBe(true)
    expect(projectionRegistry.resolveDispatch("rooms")).toBe(descriptors[0])
    expect(projectionRegistry.resolveDispatch("temperatures")).toMatchObject({
      projectionKind: "telemetry",
      protocol: "telemetry",
    })
    expect(() => projectionRegistry.resolveDispatch("missing")).toThrow("Unknown projection")

    const runtime = {}
    registerProjectionRegistry(runtime, projectionRegistry)
    expect(getProjectionDispatchDescriptors(runtime)).toBe(descriptors)
  })

  test("derives one stable run id from the complete pinned semantic identity", () => {
    const identity: ProjectionMaterializationIdentity = {
      projectionId: "rooms",
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion: {
        datasetId: "rooms",
        versionId: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      ontologyRevision: "ontology-1",
      projectionRevision: "projection-1",
      ownershipHash: "ownership-1",
    }

    const first = createProjectionRunId("project", identity)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(createProjectionRunId("project", structuredClone(identity))).toBe(first)

    const changed = (patch: Record<string, unknown>) =>
      ({ ...identity, ...patch }) as ProjectionMaterializationIdentity
    const variants: ReadonlyArray<
      readonly [field: string, projectId: string, value: ProjectionMaterializationIdentity]
    > = [
      ["projectId", "other-project", identity],
      ["projectionId", "project", changed({ projectionId: "other-projection" })],
      ["projectionKind", "project", changed({ projectionKind: "link" })],
      ["protocol", "project", changed({ protocol: "telemetry" })],
      [
        "datasetId",
        "project",
        changed({ datasetVersion: { ...identity.datasetVersion, datasetId: "other-dataset" } }),
      ],
      [
        "versionId",
        "project",
        changed({ datasetVersion: { ...identity.datasetVersion, versionId: "v2" } }),
      ],
      [
        "createdAt",
        "project",
        changed({
          datasetVersion: {
            ...identity.datasetVersion,
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        }),
      ],
      ["ontologyRevision", "project", changed({ ontologyRevision: "ontology-2" })],
      ["projectionRevision", "project", changed({ projectionRevision: "projection-2" })],
      ["ownershipHash", "project", changed({ ownershipHash: "ownership-2" })],
    ]

    for (const [field, projectId, variant] of variants) {
      expect(createProjectionRunId(projectId, variant), field).not.toBe(first)
    }
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
    const linkProjection = defineProjection("room-sensors", Room.l.hasSensor)
      .fromDataset(roomSensors)
      .sourceField("room_id")
      .targetField("sensor_id")
    const telemetryProjection = defineProjection("temperatures", Room.p.temperature)
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
      ...defineProjection("room-sensors", Room.l.hasSensor)
        .fromDataset(roomSensors)
        .sourceField("room_id")
        .targetField("sensor_id"),
      ignoredDefinitionField: true,
    }
    const telemetryProjection = {
      ...defineProjection("temperatures", Room.p.temperature)
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
    expect(projectionRegistry.listObjectProjections()[0]).toBe(resolvedObject)
    expect(projectionRegistry.listTelemetryProjections()[0]).toBe(
      projectionRegistry.resolveTelemetry("temperatures").definition
    )
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
    ;(objectProjection.properties as Record<string, string>).name = "sensor_id"
    expect(resolvedObject.properties.name).toBe("room_name")

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

  test("rejects malformed definitions instead of silently dropping them", () => {
    expect(
      () =>
        new ProjectionRegistry({
          projections: [{ _tag: "UnknownProjectionDefinition", id: "invalid" } as never],
          ontology: registry(),
          datasetsById: datasets(rooms),
        })
    ).toThrow("Invalid projection definition")
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
    const linkProjection = defineProjection("room-sensors", Room.l.hasSensor)
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
    ).toThrow(expect.objectContaining({ code: "runtime.invalid_definition" }))
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
