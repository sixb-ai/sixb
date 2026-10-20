import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  defineValueType,
  link,
  type ObjectTypeWithPropertyTokens,
  OntologyRegistry,
  ProjectionValidationError,
  prop,
  type ValueType,
  valueTypeRef,
} from "../src"
import type { ProjectionMaterializationIdentity } from "../src/materialization"
import { sha256Canonical } from "../src/materialization/identity"
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
    prop("humidity", "double", { mode: "telemetry" }),
  ],
  links: [link("hasSensor", Sensor, { cardinality: "one" })],
})
const rooms = defineDataset("rooms", {
  schema: [
    col("room_name", "string"),
    col("room_id", "string"),
    col("sensor_id", "string"),
    col("updated_at", "timestamp"),
  ],
})
const roomSensors = defineDataset("room-sensors", {
  schema: [col("sensor_id", "string"), col("room_id", "string")],
})
const readings = defineDataset("readings", {
  schema: [
    col("value", "float64"),
    col("humidity", "float64"),
    col("observed_at", "timestamp"),
    col("room_id", "string"),
  ],
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
    const temperatureProjection = defineProjection("temperatures", Room)
      .fromDataset(readings)
      .points({
        objectId: "room_id",
        at: "observed_at",
        properties: { temperature: "value", humidity: "humidity" },
      })
    const projectionRegistry = new ProjectionRegistry({
      projections: [roomProjection, temperatureProjection],
      ontology: registry(),
      datasetsById: datasets(rooms, readings),
    })

    const resolved = projectionRegistry.resolveSource("rooms")
    const objectProjections = projectionRegistry.listObjects()
    const telemetryProjections = projectionRegistry.listTelemetry()
    expect(Object.isFrozen(objectProjections)).toBe(true)
    expect(Object.isFrozen(telemetryProjections)).toBe(true)
    expect(projectionRegistry.listLinks()).toEqual([])
    expect(projectionRegistry.getById("rooms")).toBe(objectProjections[0])
    expect(projectionRegistry.getById("temperatures")).toBe(telemetryProjections[0])
    expect(resolved.definition).toBe(objectProjections[0])
    expect(projectionRegistry.resolveTelemetry("temperatures").definition).toBe(
      telemetryProjections[0]
    )
    expect(projectionRegistry.getById("missing")).toBeNull()
    expect(resolved.ownership.objects).toEqual([
      { objectTypeId: "Room", existence: true, propertyIds: ["name"] },
    ])
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.definition)).toBe(true)
    expect(Object.isFrozen(resolved.ownership.objects[0].propertyIds)).toBe(true)
    expect(projectionRegistry.resolveTelemetry("temperatures").definition.properties).toEqual({
      temperature: { valueField: "value" },
      humidity: { valueField: "humidity" },
    })
    expect(projectionRegistry.resolveTelemetry("temperatures").ownership.telemetry).toEqual([
      { objectTypeId: "Room", propertyId: "humidity" },
      { objectTypeId: "Room", propertyId: "temperature" },
    ])
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
      ontologyRevision: resolved.ontologyRevision,
      projectionRevision: resolved.projectionRevision,
      ownershipHash: resolved.ownershipHash,
    })
    expect(Object.isFrozen(descriptors[0])).toBe(true)
    expect(projectionRegistry.resolveDispatch("rooms")).toBe(descriptors[0])
    expect(projectionRegistry.resolveDispatch("temperatures")).toMatchObject({
      projectionKind: "telemetry",
      protocol: "telemetry",
      ontologyRevision: projectionRegistry.resolveTelemetry("temperatures").ontologyRevision,
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
        prop("humidity", "double", { mode: "telemetry" }),
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
    expect(computeProjectionRevision(telemetryProjection, readings)).toBe(
      sha256Canonical({
        mapping: {
          kind: "telemetry",
          objectTypeId: "Room",
          propertyId: "temperature",
          objectIdField: "room_id",
          atField: "observed_at",
          valueField: "value",
          unitField: null,
        },
        columns: [
          { name: "observed_at", type: "timestamp", nullable: false },
          { name: "room_id", type: "string", nullable: false },
          { name: "value", type: "float64", nullable: false },
        ],
      })
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

  test("keeps grouped telemetry revisions order-independent and rejects partial ownership overlap", () => {
    const first = defineProjection("room-readings", Room)
      .fromDataset(readings)
      .points({
        objectId: "room_id",
        at: "observed_at",
        properties: { temperature: "value", humidity: "humidity" },
      })
    const reordered = defineProjection("renamed", Room)
      .fromDataset(readings)
      .points({
        objectId: "room_id",
        at: "observed_at",
        properties: { humidity: "humidity", temperature: "value" },
      })

    expect(computeProjectionRevision(first, readings)).toBe(
      computeProjectionRevision(reordered, readings)
    )
    expect(
      () =>
        new ProjectionRegistry({
          projections: [
            first,
            defineProjection("humidity-only", Room.p.humidity)
              .fromDataset(readings)
              .points({ objectId: "room_id", at: "observed_at", value: "humidity" }),
          ],
          ontology: registry(),
          datasetsById: datasets(readings),
        })
    ).toThrow("overlaps telemetry source 'Room.humidity'")
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
    expect(projectionRegistry.listObjects()[0]).toBe(resolvedObject)
    expect(projectionRegistry.listTelemetry()[0]).toBe(
      projectionRegistry.resolveTelemetry("temperatures").definition
    )
    expect(Object.keys(resolvedObject)).toEqual([
      "_tag",
      "id",
      "objectTypeId",
      "datasetId",
      "properties",
      "links",
      "conflictResolution",
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
    const requiredTelemetry = () =>
      new ProjectionRegistry({
        projections: [],
        ontology: new OntologyRegistry({ sources: [RequiredTelemetry] }),
        datasetsById: new Map(),
      })
    expect(requiredTelemetry).toThrow(ProjectionValidationError)
    expect(requiredTelemetry).toThrow("cannot be required")
  })

  test("requires mostRecent to reference a non-null timestamp dataset column", () => {
    const nullableRooms = defineDataset("nullable-rooms", {
      schema: [
        col("room_name", "string"),
        col("room_id", "string"),
        col("updated_at", "timestamp", { nullable: true }),
      ],
    })
    const mostRecent =
      (dataset: typeof rooms | typeof nullableRooms, sourceTimestamp: string) => () =>
        new ProjectionRegistry({
          projections: [
            {
              ...defineProjection("rooms", Room)
                .fromDataset(dataset)
                .properties({ id: "room_id", name: "room_name" }),
              conflictResolution: { strategy: "mostRecent", sourceTimestamp },
            },
          ],
          ontology: registry(),
          datasetsById: datasets(dataset),
        })

    expect(mostRecent(rooms, "room_name")).toThrow("must reference a timestamp dataset column")
    expect(mostRecent(nullableRooms, "updated_at")).toThrow(
      "must reference a non-null timestamp dataset column"
    )
  })
})

// Each test below covers one part of `computeProjectionOntologyRevision`: drop that part from the
// hash and its test fails. Returning `computeOntologyRevision(ontology)` instead, the project-wide
// hash every projection used to pin, fails the first one.
describe("projection ontology revisions", () => {
  const Liters = defineValueType({ id: "Liters", name: "Liters", schema: "double" })
  const Flow = defineValueType({
    id: "Flow",
    name: "Flow",
    schema: {
      type: "object",
      properties: { value: { schema: valueTypeRef("Liters"), required: true } },
    },
  })
  const Vessel = defineObjectType({
    id: "Vessel",
    name: "Vessel",
    properties: [prop("id", "string", { primary: true, required: true })],
  })
  const Storage = defineObjectType({
    id: "Storage",
    name: "Storage",
    properties: [prop("id", "string", { primary: true, required: true })],
  })
  const Tank = defineObjectType({
    id: "Tank",
    name: "Tank",
    extends: Vessel,
    properties: [prop("capacity", "double")],
  })
  const Equipment = defineObjectType({
    id: "Equipment",
    name: "Equipment",
    properties: [prop("id", "string", { primary: true, required: true })],
  })
  const Pump = defineObjectType({
    id: "Pump",
    name: "Pump",
    extends: Equipment,
    properties: [
      prop("flowRate", valueTypeRef("Flow")),
      prop("pressure", "double", { mode: "telemetry" }),
    ],
    links: [link("feeds", Tank), link("drains", Tank)],
  })
  const Unrelated = defineObjectType({
    id: "Unrelated",
    name: "Unrelated",
    properties: [prop("id", "string", { primary: true, required: true })],
  })

  const pumps = defineDataset("pumps", {
    schema: [col("pump_id", "string"), col("tank_id", "string")],
  })
  const pumpTanks = defineDataset("pump-tanks", {
    schema: [col("pump_id", "string"), col("tank_id", "string")],
  })
  const pressures = defineDataset("pressures", {
    schema: [col("pump_id", "string"), col("observed_at", "timestamp"), col("value", "float64")],
  })
  const projections = [
    defineProjection("pumps", Pump)
      .fromDataset(pumps)
      .properties({ id: "pump_id" })
      .withLinks({ feeds: { link: Pump.l.feeds, sourceField: "tank_id", target: Tank } }),
    defineProjection("pump-drains", Pump.l.drains)
      .fromDataset(pumpTanks)
      .sourceField("pump_id")
      .targetField("tank_id"),
    defineProjection("pump-pressures", Pump.p.pressure)
      .fromDataset(pressures)
      .points({ objectId: "pump_id", at: "observed_at", value: "value" }),
  ]
  const baseline: readonly ObjectTypeWithPropertyTokens[] = [Equipment, Pump, Vessel, Storage, Tank]

  /** Each projection's revision, with `changed` types replacing the baseline ones of the same id. */
  function revisions(
    changed: readonly ObjectTypeWithPropertyTokens[] = [],
    valueTypes: readonly ValueType[] = [Flow, Liters]
  ): Record<string, string> {
    const objectTypes = new Map(baseline.map((type) => [type.id, type] as const))
    for (const type of changed) objectTypes.set(type.id, type)
    const ontology = new OntologyRegistry({
      sources: [
        { id: "revisions", version: "1", objectTypes: [...objectTypes.values()], valueTypes },
      ],
    })
    const registry = new ProjectionRegistry({
      projections,
      ontology,
      datasetsById: datasets(pumps, pumpTanks, pressures),
    })
    return Object.fromEntries(
      registry
        .getDispatchDescriptors()
        .map((descriptor) => [descriptor.projectionId, descriptor.ontologyRevision])
    )
  }

  function withProperty(
    type: ObjectTypeWithPropertyTokens,
    propertyId: string
  ): ObjectTypeWithPropertyTokens {
    return { ...type, properties: [...type.properties, prop(propertyId, "string")] }
  }

  const before = revisions()

  test("ignores object types a projection does not read", () => {
    expect(revisions([Unrelated])).toEqual(before)
    expect(revisions([withProperty(Unrelated, "note")])).toEqual(before)
    // A link target's own properties are not read; only what it is a subtype of.
    expect(revisions([withProperty(Tank, "note")])).toEqual(before)
  })

  test("changes with the written type, including what it inherits", () => {
    const after = revisions([withProperty(Pump, "note")])
    const inherited = revisions([withProperty(Equipment, "note")])
    for (const projectionId of Object.keys(before)) {
      expect(after[projectionId], projectionId).not.toBe(before[projectionId])
      expect(inherited[projectionId], projectionId).not.toBe(before[projectionId])
    }
  })

  test("changes with the supertypes of a link target", () => {
    const changes = [
      revisions([{ ...Tank, parents: [...(Tank.parents ?? []), "Storage"] }]),
      revisions([{ ...Tank, extends: "Storage", parents: ["Storage"] }]),
    ]
    for (const after of changes) {
      expect(after.pumps).not.toBe(before.pumps)
      expect(after["pump-drains"]).not.toBe(before["pump-drains"])
      expect(after["pump-pressures"]).toBe(before["pump-pressures"])
    }
  })

  test("changes with a value type the written type reaches transitively", () => {
    const changedLiters = defineValueType({ id: "Liters", name: "Liters", schema: "integer" })
    const after = revisions([], [Flow, changedLiters])
    for (const projectionId of Object.keys(before)) {
      expect(after[projectionId], projectionId).not.toBe(before[projectionId])
    }
  })
})
