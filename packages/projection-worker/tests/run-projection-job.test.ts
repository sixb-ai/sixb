import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  fromForeignKey,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeStorage,
  link,
  Pario,
  type ProjectionDefinition,
  type ProjectionRunStorage,
  prop,
  stringEnum,
} from "@pario/core"
import { type ProjectionWorkerContext, ProjectionWorkerError, runProjectionJob } from "../src"

const Building = defineObjectType({
  id: "Building",
  name: "Building",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("buildingRef", "string"),
  ],
  links: [
    link("inBuilding", Building, { cardinality: "one" }),
    link("hasSensors", Sensor, { cardinality: "many" }),
  ],
})

const roomsDataset = defineDataset("canonical.rooms", {
  schema: [
    col("room_id", "string"),
    col("room_name", "string"),
    col("building_ref", "string", { nullable: true }),
  ],
})

const roomSensorsDataset = defineDataset("canonical.room-sensors", {
  schema: [col("room_id", "string"), col("sensor_id", "string")],
})

const roomProjection = defineProjection("room-proj", Room)
  .fromDataset(roomsDataset)
  .properties({ id: "room_id", name: "room_name", buildingRef: "building_ref" })

const roomProjectionWithFk = roomProjection.withLinks({
  inBuilding: fromForeignKey({
    link: Room.l.inBuilding,
    sourceProperty: Room.p.buildingRef,
    target: Building,
  }),
})

const roomSensorProjection = defineLinkProjection("room-sensor-proj", Room.l.hasSensors)
  .fromDataset(roomSensorsDataset)
  .sourceField("room_id")
  .targetField("sensor_id")

interface TestRuntimeDeps {
  readonly broker: InMemoryBroker
  readonly storage: InMemoryStorage
  readonly lakeStorage: InMemoryLakeStorage
  readonly blobStorage: InMemoryBlobStorage
  readonly queues: InMemoryQueues
}

function createDeps(): TestRuntimeDeps {
  return {
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  }
}

interface ProjectionRuntimeSource {
  readonly projectId: string
  readonly ontology: ProjectionWorkerContext["ontology"]
  readonly actionRegistry: ProjectionWorkerContext["actionRegistry"]
  readonly events: ProjectionWorkerContext["events"]
  readonly storage: ProjectionWorkerContext["storage"]
  readonly lakeStorage: ProjectionWorkerContext["lakeStorage"]
  readonly blobStorage: ProjectionWorkerContext["blobStorage"]
  readonly queues: ProjectionWorkerContext["queues"]
  getDatasetById: ProjectionWorkerContext["getDatasetById"]
  getProjectionById: ProjectionWorkerContext["getProjectionById"]
}

function requireProjectionRunsStorage(input: {
  readonly storage: { readonly projectionRuns?: ProjectionRunStorage }
}): ProjectionRunStorage {
  const projectionRunsStorage = input.storage.projectionRuns
  if (!projectionRunsStorage) {
    throw new Error("Expected projection run storage in test runtime.")
  }
  return projectionRunsStorage
}

function createFinishFailingProjectionRunStorage(
  delegate: ProjectionRunStorage,
  cause: Error
): ProjectionRunStorage {
  return {
    start(input) {
      return delegate.start(input)
    },
    update(input) {
      return delegate.update(input)
    },
    async finish() {
      throw cause
    },
    getById(params) {
      return delegate.getById(params)
    },
    list(input) {
      return delegate.list(input)
    },
  }
}

function createRuntime(pario: ProjectionRuntimeSource) {
  return {
    projectId: pario.projectId,
    ontology: pario.ontology,
    actionRegistry: pario.actionRegistry,
    events: pario.events,
    storage: pario.storage,
    lakeStorage: pario.lakeStorage,
    blobStorage: pario.blobStorage,
    queues: pario.queues,
    projectionRunsStorage: requireProjectionRunsStorage(pario),
    getDatasetById(datasetId: string) {
      return pario.getDatasetById(datasetId)
    },
    getProjectionById(projectionId: string) {
      return pario.getProjectionById(projectionId)
    },
  } satisfies ProjectionWorkerContext
}

function createPario(
  options: {
    datasets: readonly DatasetDefinition[]
    projections: readonly ProjectionDefinition[]
  },
  deps = createDeps()
) {
  return new Pario({
    id: "projection-worker-tests",
    ontology: [Building, Room, Sensor],
    ...deps,
    datasets: options.datasets,
    projections: options.projections,
  })
}

async function commitDatasetVersion(
  lakeStorage: LakeStorage,
  dataset: DatasetDefinition,
  rows: readonly DatasetRow[]
) {
  await lakeStorage.createDataset(dataset)
  const write = await lakeStorage.beginWrite({
    dataset,
    mode: "snapshot",
    producer: { kind: "sync", id: "test-sync", runId: "sync-run-1" },
  })
  await write.writeRows(rows)
  return write.commit({ commitMessage: "test projection input" })
}

describe("runProjectionJob", () => {
  test("materializes an object projection from the exact dataset version", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )

    const version1 = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])
    await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Bedroom", building_ref: null },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-1",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version1.versionId,
      },
    })

    expect(result.rowsProcessed).toBe(1)
    expect(result.objectsUpserted).toBe(1)
    expect(result.run.status).toBe("succeeded")

    const room = await deps.storage.objects.getByPrimaryId({
      projectId: pario.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.name).toBe("Kitchen")
  })

  test("materializes FK links after object upserts", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    await pario.upsertObject("Building", { id: "b1", name: "HQ" })
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    expect(result.linksUpserted).toBe(1)

    const links = await deps.storage.objects.listLinks({
      projectId: pario.id,
      sourceTypeId: "Room",
      sourceId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b1")
  })

  test("keeps the run successful when an FK target is missing", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "missing-building" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-missing-fk-target",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    expect(result.linksUpserted).toBe(0)

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-missing-fk-target",
    })
    expect(run?.status).toBe("succeeded")
  })

  test("materializes a link projection from a join dataset", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomSensorsDataset],
        projections: [roomSensorProjection],
      },
      deps
    )
    await pario.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await pario.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(deps.lakeStorage, roomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1" },
      { room_id: "r1", sensor_id: "s1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-link",
        projectionId: "room-sensor-proj",
        projectionKind: "link",
        datasetId: "canonical.room-sensors",
        versionId: version.versionId,
      },
    })

    expect(result.rowsProcessed).toBe(2)
    expect(result.rowsSkipped).toBe(1)
    expect(result.linksUpserted).toBe(1)

    const links = await deps.storage.objects.listLinks({
      projectId: pario.id,
      sourceTypeId: "Room",
      sourceId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("s1")
  })

  test("skips blank object primary values and blank link fields", async () => {
    const deps = createDeps()
    const objectPario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const objectVersion = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "", room_name: "No Primary", building_ref: null },
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])

    const objectResult = await runProjectionJob({
      runtime: createRuntime(objectPario),
      job: {
        id: "projrun-blank-primary",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: objectVersion.versionId,
      },
    })

    expect(objectResult.rowsProcessed).toBe(2)
    expect(objectResult.rowsSkipped).toBe(1)
    expect(objectResult.objectsUpserted).toBe(1)

    await objectPario.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await objectPario.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const linkPario = createPario(
      {
        datasets: [roomSensorsDataset],
        projections: [roomSensorProjection],
      },
      deps
    )
    const linkVersion = await commitDatasetVersion(deps.lakeStorage, roomSensorsDataset, [
      { room_id: "", sensor_id: "s1" },
      { room_id: "r1", sensor_id: "" },
      { room_id: "r1", sensor_id: "s1" },
    ])

    const linkResult = await runProjectionJob({
      runtime: createRuntime(linkPario),
      job: {
        id: "projrun-blank-link-fields",
        projectionId: "room-sensor-proj",
        projectionKind: "link",
        datasetId: "canonical.room-sensors",
        versionId: linkVersion.versionId,
      },
    })

    expect(linkResult.rowsProcessed).toBe(3)
    expect(linkResult.rowsSkipped).toBe(2)
    expect(linkResult.linksUpserted).toBe(1)
  })

  test("marks the run failed when projected values violate ontology validation", async () => {
    const Device = defineObjectType({
      id: "Device",
      name: "Device",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("status", stringEnum(["online"])),
      ],
    })
    const devicesDataset = defineDataset("canonical.devices", {
      schema: [col("device_id", "string"), col("device_status", "string")],
    })
    const deviceProjection = defineProjection("device-proj", Device)
      .fromDataset(devicesDataset)
      .properties({ id: "device_id", status: "device_status" })
    const deps = createDeps()
    const pario = new Pario({
      id: "projection-worker-tests",
      ontology: [Device],
      ...deps,
      datasets: [devicesDataset],
      projections: [deviceProjection],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, devicesDataset, [
      { device_id: "d1", device_status: "offline" },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-invalid-property",
          projectionId: "device-proj",
          projectionKind: "object",
          datasetId: "canonical.devices",
          versionId: version.versionId,
        },
      })
    ).rejects.toBeInstanceOf(ProjectionWorkerError)

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-invalid-property",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(1)
    expect(run?.rowsSkipped).toBe(1)
    expect(run?.objectsUpserted).toBe(0)
    expect(run?.errorMessage).toContain("must be one of")
  })

  test("marks the run failed before reading rows when the committed schema mismatches", async () => {
    const deps = createDeps()
    const mismatchedRoomsDataset = defineDataset("canonical.rooms", {
      schema: [col("room_id", "string"), col("name", "string"), col("building_ref", "string")],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, mismatchedRoomsDataset, [
      { room_id: "r1", name: "Kitchen", building_ref: "b1" },
    ])
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-schema-mismatch",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("schema mismatch")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-schema-mismatch",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(0)
  })

  test("marks the run failed when the projection id is unknown", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-unknown",
          projectionId: "missing-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("Unknown projection")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-unknown",
    })
    expect(run?.status).toBe("failed")
  })

  test("fails before reading rows when an object FK target is incompatible", async () => {
    const deps = createDeps()
    const invalidFkProjection = {
      _tag: "ObjectProjectionDefinition",
      id: "room-invalid-fk-proj",
      objectTypeId: "Room",
      datasetId: roomsDataset.id,
      properties: {
        id: "room_id",
        name: "room_name",
        buildingRef: "building_ref",
      },
      links: {
        hasSensors: {
          linkId: "hasSensors",
          sourcePropertyId: "buildingRef",
          targetObjectTypeId: "Building",
        },
      },
    } satisfies ProjectionDefinition
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [invalidFkProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-invalid-fk-target",
          projectionId: "room-invalid-fk-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("not compatible")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-invalid-fk-target",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(0)
    expect(run?.errorMessage).toContain("not compatible")
  })

  test("fails before reading rows when a link projection target is incompatible", async () => {
    const deps = createDeps()
    const invalidLinkProjection = {
      ...roomSensorProjection,
      id: "room-sensor-invalid-target-proj",
      targetObjectTypeId: "Building",
    } satisfies ProjectionDefinition
    const pario = createPario(
      {
        datasets: [roomSensorsDataset],
        projections: [invalidLinkProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1" },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-invalid-link-target",
          projectionId: "room-sensor-invalid-target-proj",
          projectionKind: "link",
          datasetId: "canonical.room-sensors",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("not compatible")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-invalid-link-target",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(0)
    expect(run?.errorMessage).toContain("not compatible")
  })

  test("marks the run cancelled when the signal aborts during the final object flush", async () => {
    const deps = createDeps()
    const abortController = new AbortController()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const originalAppend = pario.events.append.bind(pario.events)
    let aborted = false
    pario.events.append = async (params) => {
      const events = await originalAppend(params)
      if (!aborted && params.events.some((event) => event.type === "object.upserted")) {
        aborted = true
        abortController.abort()
      }
      return events
    }
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-abort-final-flush",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
        signal: abortController.signal,
      })
    ).rejects.toThrow("Projection worker aborted")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-abort-final-flush",
    })
    expect(run?.status).toBe("cancelled")
    expect(run?.objectsUpserted).toBe(1)
  })

  test("throws a repair-needed error when finalization fails after materialization", async () => {
    const deps = createDeps()
    const pario = createPario(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])
    const finishCause = new Error("finish unavailable")
    const runtime = createRuntime(pario)

    try {
      await runProjectionJob({
        runtime: {
          ...runtime,
          projectionRunsStorage: createFinishFailingProjectionRunStorage(
            runtime.projectionRunsStorage,
            finishCause
          ),
        },
        job: {
          id: "projrun-finish-fails",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
      throw new Error("Expected runProjectionJob to fail.")
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionWorkerError)
      expect(error).toHaveProperty("cause", finishCause)
      expect(errorMessage(error)).toContain("may need repair")
    }
  })
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
