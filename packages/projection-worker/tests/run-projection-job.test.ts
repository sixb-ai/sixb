import { describe, expect, test } from "bun:test"
import {
  type BeginDatasetWriteInput,
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  defineValueType,
  fromForeignKey,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  integerEnum,
  type LakeStorage,
  link,
  Pario,
  type ProjectionDefinition,
  type ProjectionRunStorage,
  prop,
  type ReadDatasetRowsInput,
  stringEnum,
  valueTypeRef,
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

class RecordingLakeStorage implements LakeStorage {
  readonly standard: LakeStorage["standard"]
  readonly readInputs: ReadDatasetRowsInput[] = []

  constructor(private readonly delegate: LakeStorage) {
    this.standard = delegate.standard
  }

  assertDatasetDefinitionCompatible(definition: DatasetDefinition): Promise<void> {
    return this.delegate.assertDatasetDefinitionCompatible(definition)
  }

  createDataset(definition: DatasetDefinition): Promise<DatasetDefinition> {
    return this.delegate.createDataset(definition)
  }

  getDataset(datasetId: string): Promise<DatasetDefinition | null> {
    return this.delegate.getDataset(datasetId)
  }

  listDatasets(): Promise<readonly DatasetDefinition[]> {
    return this.delegate.listDatasets()
  }

  listVersions(datasetId: string, limit?: number) {
    return this.delegate.listVersions(datasetId, limit)
  }

  beginWrite(input: BeginDatasetWriteInput) {
    return this.delegate.beginWrite(input)
  }

  getLatestVersion(datasetId: string) {
    return this.delegate.getLatestVersion(datasetId)
  }

  getVersion(datasetId: string, versionId: string) {
    return this.delegate.getVersion(datasetId, versionId)
  }

  readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    this.readInputs.push({
      ...input,
      columns: input.columns === undefined ? undefined : [...input.columns],
    })
    return this.delegate.readRows(input)
  }
}

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
  deps: Omit<TestRuntimeDeps, "lakeStorage"> & { readonly lakeStorage: LakeStorage } = createDeps()
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

  test("object projections read only mapped dataset columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const wideRoomsDataset = defineDataset("canonical.wide-rooms", {
      schema: [
        col("room_id", "string"),
        col("room_name", "string"),
        col("unused_a", "string", { nullable: true }),
        col("unused_b", "json", { nullable: true }),
      ],
    })
    const wideRoomProjection = defineProjection("wide-room-proj", Room)
      .fromDataset(wideRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
    const pario = createPario(
      {
        datasets: [wideRoomsDataset],
        projections: [wideRoomProjection],
      },
      { ...deps, lakeStorage }
    )
    const version = await commitDatasetVersion(lakeStorage, wideRoomsDataset, [
      { room_id: "r1", room_name: "Kitchen", unused_a: "ignored", unused_b: { ignored: true } },
    ])

    await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-column-pruning-object",
        projectionId: "wide-room-proj",
        projectionKind: "object",
        datasetId: wideRoomsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "room_name"])
  })

  test("object projections tolerate required unmapped dataset columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const requiredExtraRoomsDataset = defineDataset("canonical.required-extra-rooms", {
      schema: [
        col("room_id", "string"),
        col("room_name", "string"),
        col("relationship_ref", "string"),
      ],
    })
    const requiredExtraRoomProjection = defineProjection("required-extra-room-proj", Room)
      .fromDataset(requiredExtraRoomsDataset)
      .properties({ id: "room_id", name: "room_name" })
    const pario = createPario(
      {
        datasets: [requiredExtraRoomsDataset],
        projections: [requiredExtraRoomProjection],
      },
      { ...deps, lakeStorage }
    )
    const version = await commitDatasetVersion(lakeStorage, requiredExtraRoomsDataset, [
      { room_id: "r1", room_name: "Kitchen", relationship_ref: "b1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-required-unmapped-object",
        projectionId: "required-extra-room-proj",
        projectionKind: "object",
        datasetId: requiredExtraRoomsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    expect(result.rowsSkipped).toBe(0)
    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "room_name"])
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
      objectTypeId: "Room",
      objectId: "r1",
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
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("s1")
  })

  test("link projections read only source and target columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const wideRoomSensorsDataset = defineDataset("canonical.wide-room-sensors", {
      schema: [
        col("room_id", "string"),
        col("sensor_id", "string"),
        col("unused_weight", "float64", { nullable: true }),
      ],
    })
    const wideRoomSensorProjection = defineLinkProjection(
      "wide-room-sensor-proj",
      Room.l.hasSensors
    )
      .fromDataset(wideRoomSensorsDataset)
      .sourceField("room_id")
      .targetField("sensor_id")
    const pario = createPario(
      {
        datasets: [wideRoomSensorsDataset],
        projections: [wideRoomSensorProjection],
      },
      { ...deps, lakeStorage }
    )
    await pario.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await pario.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(lakeStorage, wideRoomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1", unused_weight: 0.75 },
    ])

    await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-column-pruning-link",
        projectionId: "wide-room-sensor-proj",
        projectionKind: "link",
        datasetId: wideRoomSensorsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "sensor_id"])
  })

  test("link projections tolerate required unmapped dataset columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const requiredExtraRoomSensorsDataset = defineDataset("canonical.required-extra-room-sensors", {
      schema: [
        col("room_id", "string"),
        col("sensor_id", "string"),
        col("relationship_weight", "float64"),
      ],
    })
    const requiredExtraRoomSensorProjection = defineLinkProjection(
      "required-extra-room-sensor-proj",
      Room.l.hasSensors
    )
      .fromDataset(requiredExtraRoomSensorsDataset)
      .sourceField("room_id")
      .targetField("sensor_id")
    const pario = createPario(
      {
        datasets: [requiredExtraRoomSensorsDataset],
        projections: [requiredExtraRoomSensorProjection],
      },
      { ...deps, lakeStorage }
    )
    await pario.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await pario.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(lakeStorage, requiredExtraRoomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1", relationship_weight: 0.75 },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-required-unmapped-link",
        projectionId: "required-extra-room-sensor-proj",
        projectionKind: "link",
        datasetId: requiredExtraRoomSensorsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.linksUpserted).toBe(1)
    expect(result.rowsSkipped).toBe(0)
    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "sensor_id"])
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

  test("normalizes int64 strings mapped to integer-like object properties", async () => {
    const ReadingCount = defineValueType({
      id: "ReadingCount",
      name: "Reading Count",
      schema: "integer",
    })
    const Device = defineObjectType({
      id: "Device",
      name: "Device",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("count", "integer"),
        prop("level", integerEnum([1, 2, 3])),
        prop("readingCount", valueTypeRef(ReadingCount)),
      ],
    })
    const devicesDataset = defineDataset("canonical.integer-devices", {
      schema: [
        col("device_id", "string"),
        col("device_count", "int64"),
        col("device_level", "int64"),
        col("reading_count", "int64"),
      ],
    })
    const deviceProjection = defineProjection("integer-device-proj", Device)
      .fromDataset(devicesDataset)
      .properties({
        id: "device_id",
        count: "device_count",
        level: "device_level",
        readingCount: "reading_count",
      })
    const deps = createDeps()
    const pario = new Pario({
      id: "projection-worker-tests",
      ontology: [Device],
      ...deps,
      datasets: [devicesDataset],
      projections: [deviceProjection],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, devicesDataset, [
      {
        device_id: "d1",
        device_count: "100",
        device_level: "2",
        reading_count: "7",
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-int64-string",
        projectionId: "integer-device-proj",
        projectionKind: "object",
        datasetId: devicesDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    const device = await deps.storage.objects.getByPrimaryId({
      projectId: pario.id,
      objectTypeId: "Device",
      primaryId: "d1",
    })
    expect(device?.properties.count).toBe(100)
    expect(device?.properties.level).toBe(2)
    expect(device?.properties.readingCount).toBe(7)
  })

  test("fails unsafe int64 strings mapped to integer object properties", async () => {
    const Device = defineObjectType({
      id: "Device",
      name: "Device",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("count", "integer"),
      ],
    })
    const devicesDataset = defineDataset("canonical.unsafe-integer-devices", {
      schema: [col("device_id", "string"), col("device_count", "int64")],
    })
    const deviceProjection = defineProjection("unsafe-integer-device-proj", Device)
      .fromDataset(devicesDataset)
      .properties({ id: "device_id", count: "device_count" })
    const deps = createDeps()
    const pario = new Pario({
      id: "projection-worker-tests",
      ontology: [Device],
      ...deps,
      datasets: [devicesDataset],
      projections: [deviceProjection],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, devicesDataset, [
      { device_id: "d1", device_count: "9007199254740992" },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(pario),
        job: {
          id: "projrun-unsafe-int64-string",
          projectionId: "unsafe-integer-device-proj",
          projectionKind: "object",
          datasetId: devicesDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("cannot safely coerce")

    const run = await deps.storage.projectionRuns.getById({
      projectId: pario.id,
      id: "projrun-unsafe-int64-string",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(1)
    expect(run?.rowsSkipped).toBe(1)
    expect(run?.objectsUpserted).toBe(0)
    expect(run?.errorMessage).toContain("cannot safely coerce")
  })

  test("materializes fileRef object properties from fileRef dataset columns", async () => {
    const Document = defineObjectType({
      id: "Document",
      name: "Document",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("attachment", "fileRef"),
      ],
    })
    const documentsDataset = defineDataset("canonical.documents", {
      schema: [col("document_id", "string"), col("attachment", "fileRef")],
    })
    const documentProjection = defineProjection("document-proj", Document)
      .fromDataset(documentsDataset)
      .properties({ id: "document_id", attachment: "attachment" })
    const deps = createDeps()
    const pario = new Pario({
      id: "projection-worker-tests",
      ontology: [Document],
      ...deps,
      datasets: [documentsDataset],
      projections: [documentProjection],
    })
    const attachment = {
      blobId: "blob_document",
      digest: "sha256:document",
      sizeBytes: 8,
      fileName: "document.pdf",
      mediaType: "application/pdf",
    } as const
    const version = await commitDatasetVersion(deps.lakeStorage, documentsDataset, [
      { document_id: "doc1", attachment },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(pario),
      job: {
        id: "projrun-fileref",
        projectionId: "document-proj",
        projectionKind: "object",
        datasetId: documentsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    const document = await deps.storage.objects.getByPrimaryId({
      projectId: pario.id,
      objectTypeId: "Document",
      primaryId: "doc1",
    })
    expect(document?.properties.attachment).toEqual(attachment)
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
