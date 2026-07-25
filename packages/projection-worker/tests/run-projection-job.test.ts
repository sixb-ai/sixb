import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineLinkProjection,
  defineObjectType,
  defineProjection,
  defineTelemetryProjection,
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
  type ProjectionDefinition,
  prop,
  Sixb,
  stringEnum,
  valueTypeRef,
} from "@sixb/core"
import type { BeginDatasetWriteInput, ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import type { ProjectionRunStorage } from "@sixb/core/storage"
import { ProjectionWorkerError } from "../src/errors"
import { runProjectionJob } from "../src/run-projection-job"
import type { ProjectionWorkerContext } from "../src/types"

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
    prop("temperature", "double", { mode: "telemetry" }),
    prop("targetTemperature", "double", { mode: "telemetry", semanticType: "Temperature" }),
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

const roomReadingsDataset = defineDataset("canonical.room-readings", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("temperature", "float64"),
    col("sync_row_id", "string"),
    col("unused", "string", { nullable: true }),
  ],
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

// One dataset row per edge, so the object properties repeat identically while the link target varies.
const roomProjectionWithManyFk = defineProjection("room-proj", Room)
  .fromDataset(roomsDataset)
  .properties({ id: "room_id", name: "room_name" })
  .withLinks({
    hasSensors: fromForeignKey({
      link: Room.l.hasSensors,
      sourceField: "building_ref",
      target: Sensor,
    }),
  })

const roomProjectionWithDatasetFieldFk = defineProjection("room-dataset-field-fk-proj", Room)
  .fromDataset(roomsDataset)
  .properties({ id: "room_id", name: "room_name" })
  .withLinks({
    inBuilding: fromForeignKey({
      link: Room.l.inBuilding,
      sourceField: "building_ref",
      target: Building,
    }),
  })

const roomSensorProjection = defineLinkProjection("room-sensor-proj", Room.l.hasSensors)
  .fromDataset(roomSensorsDataset)
  .sourceField("room_id")
  .targetField("sensor_id")

const roomTemperatureProjection = defineTelemetryProjection(
  "room-temperature-proj",
  Room.p.temperature
)
  .fromDataset(roomReadingsDataset)
  .points({ objectId: "room_id", at: "observed_at", value: "temperature" })

const roomTargetsDataset = defineDataset("canonical.room-targets", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("target", "float64"),
    col("target_unit", "string", { nullable: true }),
  ],
})

const roomTargetProjection = defineTelemetryProjection("room-target-proj", Room.p.targetTemperature)
  .fromDataset(roomTargetsDataset)
  .points({ objectId: "room_id", at: "observed_at", value: "target", unit: "target_unit" })

class RecordingLakeStorage implements LakeStorage {
  readonly standard: LakeStorage["standard"]
  readonly readInputs: ReadDatasetRowsInput[] = []

  constructor(private readonly delegate: LakeStorage) {
    this.standard = delegate.standard
  }

  assertDatasetDefinitionsCompatible(definitions: readonly DatasetDefinition[]): Promise<void> {
    return this.delegate.assertDatasetDefinitionsCompatible(definitions)
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

  listDatasetCatalogState(datasetIds: readonly string[]) {
    return this.delegate.listDatasetCatalogState(datasetIds)
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
  readonly materializer: ProjectionWorkerContext["materializer"]
  readonly committedFacts: ProjectionWorkerContext["committedFacts"]
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
    listLatestByProjectionIds(input) {
      return delegate.listLatestByProjectionIds(input)
    },
  }
}

function createRuntime(sixb: ProjectionRuntimeSource) {
  return {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
    materializer: sixb.materializer,
    committedFacts: sixb.committedFacts,
    storage: sixb.storage,
    lakeStorage: sixb.lakeStorage,
    blobStorage: sixb.blobStorage,
    queues: sixb.queues,
    projectionRunsStorage: requireProjectionRunsStorage(sixb),
    getDatasetById(datasetId: string) {
      return sixb.getDatasetById(datasetId)
    },
    getProjectionById(projectionId: string) {
      return sixb.getProjectionById(projectionId)
    },
  } satisfies ProjectionWorkerContext
}

function createSixb(
  options: {
    datasets: readonly DatasetDefinition[]
    projections: readonly ProjectionDefinition[]
  },
  deps: Omit<TestRuntimeDeps, "lakeStorage"> & { readonly lakeStorage: LakeStorage } = createDeps()
) {
  return new Sixb({
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
    const sixb = createSixb(
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
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.name).toBe("Kitchen")
  })

  test("replays an object projection without emitting no-op mutations", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-object-first",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    })
    const rowBeforeReplay = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: Room.id,
      primaryId: "r1",
    })

    const replay = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-object-replay",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(replay.run.status).toBe("succeeded")
    expect(
      await deps.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: Room.id,
        primaryId: "r1",
      })
    ).toEqual(rowBeforeReplay)
    expect(await sixb.events.read({ types: ["object.created"] })).toHaveLength(1)
    expect(await sixb.events.read({ types: ["object.updated"] })).toHaveLength(0)
  })

  test("materializes a telemetry projection from the exact dataset version", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset, roomReadingsDataset],
        projections: [roomProjection, roomTemperatureProjection],
      },
      deps
    )

    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version1 = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])
    await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        temperature: 72,
        sync_row_id: "reading-2",
        unused: "ignored",
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-1",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: "canonical.room-readings",
        versionId: version1.versionId,
      },
    })

    expect(result.rowsProcessed).toBe(1)
    expect(result.telemetryPointsAppended).toBe(1)
    expect(result.telemetryPointsSkipped).toBe(0)
    expect(result.telemetryRowsFailed).toBe(0)
    expect(result.objectsUpserted).toBe(0)
    expect(result.linksUpserted).toBe(0)
    expect(result.run.status).toBe("succeeded")

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([70.5])
    expect(history[0]?.at.toISOString()).toBe("2026-06-01T12:00:00.000Z")

    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.temperature).toBe(70.5)
  })

  test("telemetry projections read only mapped dataset columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      { ...deps, lakeStorage }
    )
    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version = await commitDatasetVersion(lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-column-pruning-telemetry",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "observed_at", "temperature"])
  })

  test("telemetry projections materialize object latest by telemetry timestamp", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        temperature: 72,
        sync_row_id: "reading-2",
        unused: "ignored",
      },
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-late",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.telemetryPointsAppended).toBe(2)
    expect(result.telemetryPointsSkipped).toBe(0)
    expect(result.telemetryRowsFailed).toBe(0)

    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.temperature).toBe(72)

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([70.5, 72])
  })

  test("telemetry projections replay idempotently via the (series, at) upsert", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])

    const first = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-first",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    const replay = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-replay",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(first.telemetryPointsAppended).toBe(1)
    expect(replay.run.status).toBe("succeeded")
    expect(replay.telemetryPointsAppended).toBe(1)
    expect(replay.telemetryRowsFailed).toBe(0)

    // The store upserts on (series, at), so replaying leaves a single point.
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([70.5])
  })

  test("telemetry projections overwrite a prior value at the same instant (last-write-wins)", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version1 = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])
    const version2 = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 71,
        sync_row_id: "reading-1",
        unused: "ignored",
      },
    ])

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-v1",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version1.versionId,
      },
    })
    const second = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-v2",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version2.versionId,
      },
    })

    // Same (object, property, instant): the newer value overwrites.
    expect(second.run.status).toBe("succeeded")

    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.temperature).toBe(71)

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([71])
  })

  test("telemetry projections skip readings for missing objects and keep the run successful", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({
      properties: { id: "r1", name: "Kitchen" },
    })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: null,
      },
      {
        room_id: "missing-room",
        observed_at: "2026-06-01T12:05:00.000Z",
        temperature: 71,
        sync_row_id: "reading-2",
        unused: null,
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      batchSize: 10,
      job: {
        id: "projrun-telemetry-partial-failure",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    // A reading for an object that does not exist yet is a benign, retryable
    // skip (matching object/link projections), not a whole-run failure.
    expect(result.run.status).toBe("succeeded")
    expect(result.rowsProcessed).toBe(2)
    expect(result.rowsSkipped).toBe(1)
    expect(result.telemetryPointsAppended).toBe(1)
    expect(result.telemetryPointsSkipped).toBe(1)
    expect(result.telemetryRowsFailed).toBe(0)

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([70.5])
  })

  test("telemetry projections parse zone-less timestamps as UTC", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01 12:00:00",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-zoneless",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.telemetryPointsAppended).toBe(1)

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.at.toISOString())).toEqual(["2026-06-01T12:00:00.000Z"])
  })

  test("telemetry projections upsert rows that share an instant within one version (last-write-wins)", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: null,
      },
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 71,
        sync_row_id: "reading-2",
        unused: null,
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-inbatch",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    // Both rows share (object, property, instant); the upsert keeps the last.
    expect(result.run.status).toBe("succeeded")
    expect(result.telemetryRowsFailed).toBe(0)

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([71])
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
    const sixb = createSixb(
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
      runtime: createRuntime(sixb),
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
    const sixb = createSixb(
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
      runtime: createRuntime(sixb),
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
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    await sixb.upsertObject("Building", { id: "b1", name: "HQ" })
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b1")
  })

  test("atomically reassigns cardinality-one FK links", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    await sixb.upsertObject("Building", { id: "b1", name: "Old HQ" })
    await sixb.upsertObject("Building", { id: "b2", name: "New HQ" })
    await sixb.upsertObject("Room", { id: "r1", name: "Kitchen", buildingRef: "b1" })
    await sixb.upsertLink("Room", "r1", "inBuilding", {
      targetTypeId: "Building",
      targetId: "b1",
    })
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b2" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-reassign-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.linksUpserted).toBe(1)

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b2")

    const repeated = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-reassign-fk-repeated",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })
    expect(repeated.run.status).toBe("succeeded")
    expect(repeated.linksUpserted).toBe(1)
    expect(
      await deps.storage.objects.listLinks({
        projectId: sixb.id,
        objectTypeId: "Room",
        objectId: "r1",
        linkId: "inBuilding",
      })
    ).toHaveLength(1)
  })

  test("keeps cardinality-many FK links additive", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithManyFk],
      },
      deps
    )
    for (const sensorId of ["s1", "s2"]) {
      await sixb.upsertObject("Sensor", { id: sensorId, name: sensorId })
    }
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "s1" },
      { room_id: "r1", room_name: "Kitchen", building_ref: "s2" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-many-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.linksUpserted).toBe(2)
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links.map((link) => link.targetId).sort()).toEqual(["s1", "s2"])
  })

  test("converges repeated FK edges onto one link with distinct committed facts", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    for (const buildingId of ["b1", "b2"]) {
      await sixb.upsertObject("Building", { id: buildingId, name: buildingId })
    }

    const publish = sixb.events.publishEnvelopes.bind(sixb.events)
    const publishedB1Creates: string[] = []
    sixb.events.publishEnvelopes = async (envelopes) => {
      for (const envelope of envelopes) {
        if (envelope.type === "link.created" && envelope.payload.targetId === "b1") {
          publishedB1Creates.push(envelope.id)
        }
      }
      return publish(envelopes)
    }

    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
      { room_id: "r1", room_name: "Kitchen", building_ref: "b2" },
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])
    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-repeated-edge",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
      batchSize: 1,
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.linksUpserted).toBe(3)
    // Each assignment commit is its own fact; stable event ids keep them distinguishable.
    expect(publishedB1Creates).toHaveLength(2)
    expect(new Set(publishedB1Creates).size).toBe(2)

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links.map((link) => link.targetId)).toEqual(["b1"])
  })

  test("preserves cardinality-one links for blank or missing FK targets", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    await sixb.upsertObject("Building", { id: "b1", name: "HQ" })
    for (const roomId of ["r1", "r2"]) {
      await sixb.upsertObject("Room", { id: roomId, name: roomId, buildingRef: "b1" })
      await sixb.upsertLink("Room", roomId, "inBuilding", {
        targetTypeId: "Building",
        targetId: "b1",
      })
    }
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
      { room_id: "r2", room_name: "Office", building_ref: "missing-building" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-preserve-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.run.status).toBe("succeeded")
    expect(result.linksUpserted).toBe(0)
    for (const roomId of ["r1", "r2"]) {
      const links = await deps.storage.objects.listLinks({
        projectId: sixb.id,
        objectTypeId: "Room",
        objectId: roomId,
        linkId: "inBuilding",
      })
      expect(links).toHaveLength(1)
      expect(links[0]?.targetId).toBe("b1")
    }
  })

  test("materializes FK links from dataset fields without storing FK properties", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithDatasetFieldFk],
      },
      deps
    )
    await sixb.upsertObject("Building", { id: "b1", name: "HQ" })
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-field-fk",
        projectionId: "room-dataset-field-fk-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

    expect(result.objectsUpserted).toBe(1)
    expect(result.linksUpserted).toBe(1)

    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties).toEqual({ id: "r1", name: "Kitchen" })

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toHaveLength(1)
    expect(links[0]?.targetId).toBe("b1")
  })

  test("keeps the run successful when an FK target is missing", async () => {
    const deps = createDeps()
    const sixb = createSixb(
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
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      id: "projrun-missing-fk-target",
    })
    expect(run?.status).toBe("succeeded")
  })

  test("materializes a link projection from a join dataset", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomSensorsDataset],
        projections: [roomSensorProjection],
      },
      deps
    )
    await sixb.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(deps.lakeStorage, roomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1" },
      { room_id: "r1", sensor_id: "s1" },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
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
    const sixb = createSixb(
      {
        datasets: [wideRoomSensorsDataset],
        projections: [wideRoomSensorProjection],
      },
      { ...deps, lakeStorage }
    )
    await sixb.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(lakeStorage, wideRoomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1", unused_weight: 0.75 },
    ])

    await runProjectionJob({
      runtime: createRuntime(sixb),
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
    const sixb = createSixb(
      {
        datasets: [requiredExtraRoomSensorsDataset],
        projections: [requiredExtraRoomSensorProjection],
      },
      { ...deps, lakeStorage }
    )
    await sixb.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await sixb.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const version = await commitDatasetVersion(lakeStorage, requiredExtraRoomSensorsDataset, [
      { room_id: "r1", sensor_id: "s1", relationship_weight: 0.75 },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
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
    const objectSixb = createSixb(
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
      runtime: createRuntime(objectSixb),
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

    await objectSixb.upsertObject("Room", { id: "r1", name: "Kitchen" })
    await objectSixb.upsertObject("Sensor", { id: "s1", name: "Motion" })
    const linkSixb = createSixb(
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
      runtime: createRuntime(linkSixb),
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
    const sixb = new Sixb({
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
        runtime: createRuntime(sixb),
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
      projectId: sixb.id,
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
    const sixb = new Sixb({
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
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
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
    const sixb = new Sixb({
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
        runtime: createRuntime(sixb),
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
      projectId: sixb.id,
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
    const sixb = new Sixb({
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
      runtime: createRuntime(sixb),
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
      projectId: sixb.id,
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
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      id: "projrun-schema-mismatch",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(0)
  })

  test("marks the run failed when the projection id is unknown", async () => {
    const deps = createDeps()
    const sixb = createSixb(
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
        runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      id: "projrun-unknown",
    })
    expect(run?.status).toBe("failed")
  })

  test("rejects an incompatible object FK target at startup before reading rows", () => {
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
    expect(() =>
      createSixb(
        {
          datasets: [roomsDataset],
          projections: [invalidFkProjection],
        },
        deps
      )
    ).toThrow("not compatible")
  })

  test("rejects an incompatible link projection target at startup before reading rows", () => {
    const deps = createDeps()
    const invalidLinkProjection = {
      ...roomSensorProjection,
      id: "room-sensor-invalid-target-proj",
      targetObjectTypeId: "Building",
    } satisfies ProjectionDefinition
    expect(() =>
      createSixb(
        {
          datasets: [roomSensorsDataset],
          projections: [invalidLinkProjection],
        },
        deps
      )
    ).toThrow("not compatible")
  })

  test("marks the run cancelled when the signal aborts during the final object flush", async () => {
    const deps = createDeps()
    const abortController = new AbortController()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const publish = sixb.events.publishEnvelopes.bind(sixb.events)
    let aborted = false
    sixb.events.publishEnvelopes = async (envelopes) => {
      const published = await publish(envelopes)
      if (
        !aborted &&
        envelopes.some(
          (envelope) => envelope.type === "object.created" || envelope.type === "object.updated"
        )
      ) {
        aborted = true
        abortController.abort()
      }
      return published
    }
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
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
      projectId: sixb.id,
      id: "projrun-abort-final-flush",
    })
    expect(run?.status).toBe("cancelled")
    expect(run?.objectsUpserted).toBe(1)
  })

  test("throws a repair-needed error when finalization fails after materialization", async () => {
    const deps = createDeps()
    const sixb = createSixb(
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
    const runtime = createRuntime(sixb)

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

  test("telemetry projections carry units in history and materialize the latest value", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [roomTargetsDataset],
        projections: [roomTargetProjection],
      },
      { ...deps, lakeStorage }
    )

    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(lakeStorage, roomTargetsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        target: 21,
        target_unit: "degreeCelsius",
      },
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        target: 22,
        target_unit: "degreeCelsius",
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-target",
        projectionId: "room-target-proj",
        projectionKind: "telemetry",
        datasetId: roomTargetsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.telemetryPointsAppended).toBe(2)
    expect(result.telemetryRowsFailed).toBe(0)
    expect(result.run.status).toBe("succeeded")

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "targetTemperature",
    })
    expect(history.map((point) => point.value)).toEqual([21, 22])
    expect(history.map((point) => point.unit)).toEqual(["degreeCelsius", "degreeCelsius"])

    // The mapped unit column must be read, and the object materializes the latest raw value.
    expect(lakeStorage.readInputs[0]?.columns).toContain("target_unit")
    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.targetTemperature).toBe(22)
  })

  test("isolates an invalid-unit telemetry row, failing the run while keeping good points", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomTargetsDataset],
        projections: [roomTargetProjection],
      },
      deps
    )

    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(deps.lakeStorage, roomTargetsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        target: 21,
        target_unit: "degreeCelsius",
      },
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        target: 22,
        target_unit: "bananas", // not a Temperature unit -> OntologyValidationError at append time
      },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-target-bad-unit",
          projectionId: "room-target-proj",
          projectionKind: "telemetry",
          datasetId: roomTargetsDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toBeInstanceOf(ProjectionWorkerError)

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: "projrun-target-bad-unit",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(2)
    expect(run?.telemetryPointsAppended).toBe(1)
    expect(run?.telemetryRowsFailed).toBe(1)
    expect(run?.errorMessage).toContain("Invalid unit")

    // The good reading from the same batch still landed via per-row isolation.
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "targetTemperature",
    })
    expect(history.map((point) => point.value)).toEqual([21])
  })

  test("fails before reading rows when a telemetry at field is not date-like", async () => {
    const deps = createDeps()
    const invalidAtProjection = {
      _tag: "TelemetryProjectionDefinition",
      id: "room-invalid-at-proj",
      objectTypeId: "Room",
      propertyId: "temperature",
      datasetId: roomReadingsDataset.id,
      objectIdField: "room_id",
      atField: "temperature", // float64 column, not date-like
      valueField: "temperature",
    } satisfies ProjectionDefinition
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [invalidAtProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 70.5,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-invalid-at",
          projectionId: "room-invalid-at-proj",
          projectionKind: "telemetry",
          datasetId: roomReadingsDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("must be a string, date, or timestamp")

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: "projrun-invalid-at",
    })
    expect(run?.status).toBe("failed")
    expect(run?.rowsProcessed).toBe(0)
  })
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
