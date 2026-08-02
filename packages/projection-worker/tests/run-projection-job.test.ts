import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
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
  MaterializationCancellationError,
  MaterializationConflictError,
  MaterializationValidationError,
  type ProjectionDefinition,
  prop,
  Sixb,
  stringEnum,
  valueTypeRef,
} from "@sixb/core"
import type { EventsRuntime } from "@sixb/core/internal/events"
import {
  createProjectionRunId,
  getProjectionRegistry,
  type ProjectionDispatchDescriptor,
  shareProjectionRegistry,
} from "@sixb/core/internal/projections"
import { shareOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { decorateOperationScopedMethodForTesting } from "@sixb/core/internal/storage-operation-scope"
import type { BeginDatasetWriteInput, ReadDatasetRowsInput } from "@sixb/core/lake-storage"
import type {
  AbandonSourceMaterializationCandidateInput,
  OntologySourceRecord,
  ProjectionRunStorage,
  ReclaimSourceMaterializationInput,
} from "@sixb/core/storage"
import { MISSING_TARGET_GRACE_MS } from "../src/retry-backoff"
import {
  isPermanentProjectionFailure,
  runProjectionJob as runCanonicalProjectionJob,
} from "../src/run-projection-job"
import type {
  ProjectionJob,
  ProjectionJobResult,
  ProjectionWorkerContext,
  RunProjectionJobInput,
} from "../src/types"

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

const roomSensorProjection = defineProjection("room-sensor-proj", Room.l.hasSensors)
  .fromDataset(roomSensorsDataset)
  .sourceField("room_id")
  .targetField("sensor_id")

const roomTemperatureProjection = defineProjection("room-temperature-proj", Room.p.temperature)
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

const roomTargetProjection = defineProjection("room-target-proj", Room.p.targetTemperature)
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

class InterruptibleLakeStorage extends RecordingLakeStorage {
  failAfterRows: number | undefined
  stopAfterRows: number | undefined
  omitVersionRowCount = false

  override async getVersion(datasetId: string, versionId: string) {
    const version = await super.getVersion(datasetId, versionId)
    if (!version || !this.omitVersionRowCount) return version
    const { rowCount: _rowCount, ...withoutRowCount } = version
    return withoutRowCount
  }

  override async *readRows(input: ReadDatasetRowsInput): AsyncIterable<DatasetRow> {
    let rowsRead = 0
    for await (const row of super.readRows(input)) {
      if (this.stopAfterRows !== undefined && rowsRead >= this.stopAfterRows) return
      if (this.failAfterRows !== undefined && rowsRead >= this.failAfterRows) {
        throw new Error("lake read interrupted")
      }
      rowsRead += 1
      yield row
    }
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
    throw new Error("Expected materialization-capable projection run storage in test runtime.")
  }
  return projectionRunsStorage
}

function createRuntime(sixb: ProjectionRuntimeSource) {
  const runtime = {
    projectId: sixb.projectId,
    ontology: sixb.ontology,
    actionRegistry: sixb.actionRegistry,
    events: sixb.events,
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
  shareOntologyMutationRuntime(sixb, runtime)
  shareProjectionRegistry(sixb, runtime)
  return runtime
}

interface LegacyTestProjectionJob {
  readonly id: string
  readonly projectionId: string
  readonly projectionKind: "object" | "link" | "telemetry"
  readonly datasetId: string
  readonly versionId: string
}

const canonicalRunIds = new Map<string, string>()

async function runProjectionJob(
  input: Omit<RunProjectionJobInput, "job"> & {
    readonly job: LegacyTestProjectionJob
    readonly batchSize?: number
  }
): Promise<ProjectionJobResult> {
  const registry = getProjectionRegistry(input.runtime)
  const version = await input.runtime.lakeStorage.getVersion(
    input.job.datasetId,
    input.job.versionId
  )
  let descriptor: ProjectionDispatchDescriptor
  try {
    descriptor = registry.resolveDispatch(input.job.projectionId)
  } catch {
    descriptor = unknownProjectionDescriptor(input.job, registry.ontologyRevision)
  }
  const { datasetId: _descriptorDatasetId, ...semanticIdentity } = descriptor
  const identity = {
    ...semanticIdentity,
    datasetVersion: {
      datasetId: input.job.datasetId,
      versionId: input.job.versionId,
      createdAt: version?.createdAt.toISOString() ?? "1970-01-01T00:00:00.000Z",
    },
  }
  const id = createProjectionRunId(input.runtime.projectId, identity)
  canonicalRunIds.set(input.job.id, id)
  const { batchSize, ...canonicalInput } = input
  return runCanonicalProjectionJob({
    ...canonicalInput,
    job: { id, ...identity },
    ...(batchSize === undefined ? {} : { telemetryBatchSize: batchSize }),
  })
}

function unknownProjectionDescriptor(
  job: LegacyTestProjectionJob,
  ontologyRevision: string
): ProjectionDispatchDescriptor {
  const common = {
    projectionId: job.projectionId,
    datasetId: job.datasetId,
    ontologyRevision,
    projectionRevision: "unknown-projection",
    ownershipHash: "unknown-projection",
  }
  switch (job.projectionKind) {
    case "object":
      return { ...common, projectionKind: "object", protocol: "replacement" }
    case "link":
      return { ...common, projectionKind: "link", protocol: "replacement" }
    case "telemetry":
      return { ...common, projectionKind: "telemetry", protocol: "telemetry" }
  }
}

function canonicalRunId(testRunId: string): string {
  const id = canonicalRunIds.get(testRunId)
  if (id) return id
  throw new Error(`Test projection run '${testRunId}' was not dispatched.`)
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
  test("classifies only terminal materialization conflicts as permanent", () => {
    expect(
      isPermanentProjectionFailure(
        new MaterializationConflictError("projection-fence", "A newer version is active.")
      )
    ).toBe(true)
    expect(
      isPermanentProjectionFailure(
        new MaterializationConflictError("run-correlation", "Identity mismatch.")
      )
    ).toBe(true)
    expect(
      isPermanentProjectionFailure(
        new MaterializationConflictError("execution-lost", "Delivery was reclaimed.")
      )
    ).toBe(false)
    expect(
      isPermanentProjectionFailure(
        new MaterializationConflictError("effective-state", "Concurrent state changed.")
      )
    ).toBe(false)
  })

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

    expect(result.run.progress.sourceRowsRead).toBe(1)
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

    expect(result.run.progress.sourceRowsRead).toBe(1)
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

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-telemetry-late",
        projectionId: "room-temperature-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

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

    await runProjectionJob({
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

    expect(replay.run.status).toBe("succeeded")
    expect(replay.replayedTerminal).toBe(true)

    // The store upserts on (series, at), so replaying leaves a single point.
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([70.5])
  })

  test("replays a terminal run without reading registry or lake state", async () => {
    const deps = createDeps()
    const sixb = createSixb({ datasets: [roomsDataset], projections: [roomProjection] }, deps)
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])
    const descriptor = getProjectionRegistry(sixb).resolveDispatch(roomProjection.id)
    if (descriptor.projectionKind !== "object") throw new Error("Expected object projection.")
    const identity = {
      projectionId: descriptor.projectionId,
      projectionKind: "object" as const,
      protocol: "replacement" as const,
      datasetVersion: {
        datasetId: version.datasetId,
        versionId: version.versionId,
        createdAt: version.createdAt.toISOString(),
      },
      ontologyRevision: descriptor.ontologyRevision,
      projectionRevision: descriptor.projectionRevision,
      ownershipHash: descriptor.ownershipHash,
    }
    const job: ProjectionJob = {
      id: createProjectionRunId(sixb.id, identity),
      ...identity,
    }
    const runtime = createRuntime(sixb)
    await runCanonicalProjectionJob({ runtime, job })

    const unavailable = () => {
      throw new Error("terminal replay accessed current configuration or lake state")
    }
    const replayRuntime: ProjectionWorkerContext = {
      ...runtime,
      lakeStorage: new Proxy(runtime.lakeStorage, { get: unavailable }),
      getDatasetById: unavailable,
      getProjectionById: unavailable,
    }

    await expect(runCanonicalProjectionJob({ runtime: replayRuntime, job })).resolves.toMatchObject(
      {
        run: { id: job.id, status: "succeeded" },
        replayedTerminal: true,
      }
    )
  })

  test("resumes telemetry from the durable offset without an exact-multiple empty commit", async () => {
    const deps = createDeps()
    const lakeStorage = new InterruptibleLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      { ...deps, lakeStorage }
    )
    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(
      lakeStorage,
      roomReadingsDataset,
      Array.from({ length: 4 }, (_, index) => ({
        room_id: "r1",
        observed_at: `2026-06-01T12:0${index}:00.000Z`,
        temperature: 70 + index,
        sync_row_id: `reading-${index}`,
        unused: null,
      }))
    )
    const input = {
      runtime: createRuntime(sixb),
      batchSize: 2,
      job: {
        id: "projrun-telemetry-resume",
        projectionId: roomTemperatureProjection.id,
        projectionKind: "telemetry" as const,
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    }

    lakeStorage.failAfterRows = 2
    await expect(runProjectionJob(input)).rejects.toThrow("lake read interrupted")
    const runId = canonicalRunId(input.job.id)
    expect(
      await deps.storage.projectionRuns.getById({ projectId: sixb.id, id: runId })
    ).toMatchObject({
      status: "running",
      attempt: 1,
      progress: { sourceRowsRead: 2 },
      telemetryCheckpoint: { nextBatchOrdinal: 1, nextRowOffset: 2, inputExhausted: false },
    })

    lakeStorage.failAfterRows = undefined
    await expect(runProjectionJob(input)).resolves.toMatchObject({
      run: {
        status: "succeeded",
        attempt: 2,
        progress: { sourceRowsRead: 4 },
        telemetryCheckpoint: { nextBatchOrdinal: 2, nextRowOffset: 4, inputExhausted: true },
      },
    })
    expect(lakeStorage.readInputs.map((read) => read.offset)).toEqual([0, 2])

    const commits = await deps.storage.ontology.commits.list({
      projectId: sixb.id,
      run: { kind: "projection", id: runId },
    })
    expect(
      commits.commits.map((commit) =>
        commit.intent.kind === "telemetry" && commit.intent.source.kind === "projection"
          ? commit.intent.source.batchOrdinal
          : null
      )
    ).toEqual([0, 1])
  })

  test("does not complete telemetry when a known pinned row count is not reached", async () => {
    const deps = createDeps()
    const lakeStorage = new InterruptibleLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      { ...deps, lakeStorage }
    )
    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(
      lakeStorage,
      roomReadingsDataset,
      Array.from({ length: 3 }, (_, index) => ({
        room_id: "r1",
        observed_at: `2026-06-01T12:0${index}:00.000Z`,
        temperature: 70 + index,
        sync_row_id: `reading-${index}`,
        unused: null,
      }))
    )
    const input = {
      runtime: createRuntime(sixb),
      batchSize: 2,
      job: {
        id: "projrun-telemetry-short-read",
        projectionId: roomTemperatureProjection.id,
        projectionKind: "telemetry" as const,
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    }

    lakeStorage.stopAfterRows = 2
    await expect(runProjectionJob(input)).rejects.toThrow("reached EOF after 2 of 3 pinned rows")
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId(input.job.id),
      })
    ).toMatchObject({
      status: "running",
      progress: { sourceRowsRead: 2 },
      telemetryCheckpoint: { nextRowOffset: 2, inputExhausted: false },
    })

    lakeStorage.stopAfterRows = undefined
    await expect(runProjectionJob(input)).resolves.toMatchObject({
      run: {
        status: "succeeded",
        progress: { sourceRowsRead: 3 },
        telemetryCheckpoint: { nextRowOffset: 3, inputExhausted: true },
      },
    })
  })

  test("finishes empty telemetry input without creating a batch commit", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      batchSize: 2,
      job: {
        id: "projrun-empty-telemetry",
        projectionId: roomTemperatureProjection.id,
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.run).toMatchObject({
      status: "succeeded",
      progress: { sourceRowsRead: 0 },
      telemetryCheckpoint: { nextBatchOrdinal: 0, nextRowOffset: 0, inputExhausted: true },
    })
    await expect(
      deps.storage.ontology.commits.list({
        projectId: sixb.id,
        run: { kind: "projection", id: result.run.id },
      })
    ).resolves.toMatchObject({ commits: [], total: 0 })
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

  test("fails one telemetry batch atomically once a missing object outlives its retries", async () => {
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

    const job = {
      id: "projrun-telemetry-partial-failure",
      projectionId: "room-temperature-proj",
      projectionKind: "telemetry" as const,
      datasetId: roomReadingsDataset.id,
      versionId: version.versionId,
    }
    // Resolved lazily: the canonical id only exists once the job has been dispatched.
    const readRun = () =>
      deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-telemetry-partial-failure"),
      })

    // The clock is injected rather than waited out — two minutes of real time is not a unit
    // test. This delivery is the one that finds the object missing, so it starts the wait and
    // leaves the run retryable however old the run itself is.
    const startedWaitingAt = Date.now()
    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        batchSize: 10,
        now: () => startedWaitingAt,
        job,
      })
    ).rejects.toThrow("missing object")

    expect(await readRun()).toMatchObject({
      status: "running",
      missingTarget: { objectTypeId: "Room", objectId: "missing-room", batchOrdinal: 0 },
    })

    // A later delivery, past the grace, finds the same object at the same batch: the source
    // names something the ontology does not have, not something merely early.
    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        batchSize: 10,
        now: () => startedWaitingAt + MISSING_TARGET_GRACE_MS + 1,
        job,
      })
    ).rejects.toThrow("missing object")

    const run = await readRun()
    expect(run).toMatchObject({
      status: "failed",
      progress: { sourceRowsRead: 0, sourceRowsSkipped: 0 },
    })

    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history).toEqual([])
  })

  test("leaves the run retryable while a missing object may still be arriving", async () => {
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
        room_id: "missing-room",
        observed_at: "2026-06-01T12:05:00.000Z",
        temperature: 71,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        batchSize: 10,
        job: {
          id: "projrun-telemetry-missing-target-early",
          projectionId: "room-temperature-proj",
          projectionKind: "telemetry",
          datasetId: roomReadingsDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("missing object")

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-telemetry-missing-target-early"),
    })
    // Left running, which is what the queue reads as "redeliver me": the worker retries a run it
    // finds still running and refuses to retry one recorded as failed. A telemetry projection and
    // the object projection feeding it are queued from separate dataset versions and nothing
    // sequences them, so failing on the first delivery turned a wait of milliseconds into a
    // permanent hole — nothing retries a failed run, and an unchanged source produces no new
    // version to run against.
    expect(run?.status).toBe("running")
  })

  test("gives a long-running run the full grace on a target it has only just missed", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      { datasets: [roomReadingsDataset], projections: [roomTemperatureProjection] },
      deps
    )
    await sixb.objects(Room).upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "missing-room",
        observed_at: "2026-06-01T12:05:00.000Z",
        temperature: 71,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])

    // Far past the grace measured from the *run*, which is how this used to be read: a batched
    // projection commits for minutes before reaching the batch that cannot, so anchoring the
    // window at `startedAt` gave a long run no grace at all on its first missing target.
    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        batchSize: 10,
        now: () => Date.now() + MISSING_TARGET_GRACE_MS * 10,
        job: {
          id: "projrun-telemetry-old-run-fresh-miss",
          projectionId: "room-temperature-proj",
          projectionKind: "telemetry",
          datasetId: roomReadingsDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("missing object")

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-telemetry-old-run-fresh-miss"),
    })
    expect(run?.status).toBe("running")
  })

  test("surfaces a storage failure instead of restarting the wait forever", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      { datasets: [roomReadingsDataset], projections: [roomTemperatureProjection] },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "missing-room",
        observed_at: "2026-06-01T12:05:00.000Z",
        temperature: 71,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])

    // An unreachable database is not a wait that has run out. Swallowed, it would leave no
    // durable `firstSeenAt`, every delivery would start the window again, and the run would stay
    // running for good.
    // Patched in place rather than spread: the runtime carries a shared projection registry
    // keyed by object identity, and a copy of it is not registered.
    const runtime = createRuntime(sixb)
    runtime.projectionRunsStorage.recordMissingTarget = () =>
      Promise.reject(new Error("connection terminated unexpectedly"))

    await expect(
      runProjectionJob({
        runtime,
        batchSize: 10,
        job: {
          id: "projrun-telemetry-wait-write-fails",
          projectionId: "room-temperature-proj",
          projectionKind: "telemetry",
          datasetId: roomReadingsDataset.id,
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("connection terminated unexpectedly")
  })

  test("clears the wait and finishes when the target arrives between deliveries", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      { datasets: [roomReadingsDataset], projections: [roomTemperatureProjection] },
      deps
    )
    const version = await commitDatasetVersion(deps.lakeStorage, roomReadingsDataset, [
      {
        room_id: "late-room",
        observed_at: "2026-06-01T12:05:00.000Z",
        temperature: 71,
        sync_row_id: "reading-1",
        unused: null,
      },
    ])
    const job = {
      id: "projrun-telemetry-target-arrives",
      projectionId: "room-temperature-proj",
      projectionKind: "telemetry" as const,
      datasetId: roomReadingsDataset.id,
      versionId: version.versionId,
    }
    const readRun = () =>
      deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-telemetry-target-arrives"),
      })

    await expect(
      runProjectionJob({ runtime: createRuntime(sixb), batchSize: 10, job })
    ).rejects.toThrow("missing object")
    expect(await readRun()).toMatchObject({ missingTarget: { objectId: "late-room" } })

    await sixb.objects(Room).upsert({ properties: { id: "late-room", name: "Late" } })
    await runProjectionJob({ runtime: createRuntime(sixb), batchSize: 10, job })

    const run = await readRun()
    expect(run?.status).toBe("succeeded")
    expect(run?.missingTarget).toBeUndefined()
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "late-room",
      propertyId: "temperature",
    })
    expect(history.map((point) => point.value)).toEqual([71])
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

    expect(result.run.progress.sourceRowsSkipped).toBe(0)
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

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

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
    const firstVersion = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: "b1" },
    ])
    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-initial-fk",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: firstVersion.versionId,
      },
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
    expect(
      await deps.storage.objects.listLinks({
        projectId: sixb.id,
        objectTypeId: "Room",
        objectId: "r1",
        linkId: "inBuilding",
      })
    ).toHaveLength(1)
  })

  test("rejects duplicate object roots instead of merging repeated source rows", async () => {
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

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-many-fk",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("repeats root")

    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-many-fk"),
      })
    ).toMatchObject({ status: "failed", progress: { sourceRowsRead: 2 } })
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links).toEqual([])
  })

  test("does not activate a replacement shorter than its persisted progress floor", async () => {
    const deps = createDeps()
    const lakeStorage = new InterruptibleLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      { datasets: [roomsDataset], projections: [roomProjection] },
      { ...deps, lakeStorage }
    )
    const initialVersion = await commitDatasetVersion(lakeStorage, roomsDataset, [
      { room_id: "old", room_name: "Old room", building_ref: null },
    ])
    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-replacement-floor-initial",
        projectionId: roomProjection.id,
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: initialVersion.versionId,
      },
    })

    const nextVersion = await commitDatasetVersion(
      lakeStorage,
      roomsDataset,
      ["one", "two", "three"].map((id) => ({
        room_id: id,
        room_name: `Room ${id}`,
        building_ref: null,
      }))
    )
    const input = {
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-replacement-floor",
        projectionId: roomProjection.id,
        projectionKind: "object" as const,
        datasetId: roomsDataset.id,
        versionId: nextVersion.versionId,
      },
    }
    lakeStorage.omitVersionRowCount = true
    lakeStorage.failAfterRows = 2
    await expect(runProjectionJob(input)).rejects.toThrow("lake read interrupted")

    lakeStorage.failAfterRows = undefined
    lakeStorage.stopAfterRows = 1
    await expect(runProjectionJob(input)).rejects.toThrow("persisted progress floor")
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId(input.job.id),
      })
    ).toMatchObject({ status: "running", attempt: 2, progress: { sourceRowsRead: 2 } })
    expect(
      await deps.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: Room.id,
        primaryId: "old",
      })
    ).toMatchObject({ properties: { name: "Old room" } })
    expect(
      await deps.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: Room.id,
        primaryId: "one",
      })
    ).toBeNull()
  })

  test("keeps the run running when candidate abandonment cannot be confirmed", async () => {
    const deps = createDeps()
    const sixb = createSixb({ datasets: [roomsDataset], projections: [roomProjection] }, deps)
    const version = await commitDatasetVersion(deps.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
    ])
    const abandonmentFailure = new Error("candidate abandonment unavailable")
    const restoreAbandon = decorateOperationScopedMethodForTesting(
      deps.storage.ontology.sources,
      "abandon",
      (abandon) => {
        function failCandidateAbandonment(
          input: AbandonSourceMaterializationCandidateInput
        ): Promise<OntologySourceRecord>
        function failCandidateAbandonment(
          input: ReclaimSourceMaterializationInput
        ): Promise<OntologySourceRecord | null>
        async function failCandidateAbandonment(
          input: AbandonSourceMaterializationCandidateInput | ReclaimSourceMaterializationInput
        ): Promise<OntologySourceRecord | null> {
          if (input.kind === "candidate") throw abandonmentFailure
          return abandon(input)
        }
        return failCandidateAbandonment
      }
    )

    try {
      await expect(
        runProjectionJob({
          runtime: createRuntime(sixb),
          job: {
            id: "projrun-abandonment-fails",
            projectionId: roomProjection.id,
            projectionKind: "object",
            datasetId: roomsDataset.id,
            versionId: version.versionId,
          },
        })
      ).rejects.toBe(abandonmentFailure)
    } finally {
      restoreAbandon()
    }

    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-abandonment-fails"),
      })
    ).toMatchObject({ status: "running", attempt: 1 })
  })

  test("rejects non-contiguous repetitions of the same object root", async () => {
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

    const events = sixb.events as EventsRuntime
    const publish = events.publishEnvelopes.bind(events)
    const publishedB1Creates: string[] = []
    events.publishEnvelopes = async (envelopes) => {
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
    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-repeated-edge",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: "canonical.rooms",
          versionId: version.versionId,
        },
      })
    ).rejects.toThrow("repeats root")
    expect(publishedB1Creates).toEqual([])

    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "inBuilding",
    })
    expect(links).toEqual([])
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

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-field-fk",
        projectionId: "room-dataset-field-fk-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    })

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

    expect(result.run.status).toBe("succeeded")
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

    expect(result.run.progress.sourceRowsRead).toBe(1)
    expect(result.run.progress.sourceRowsSkipped).toBe(0)

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
    const wideRoomSensorProjection = defineProjection("wide-room-sensor-proj", Room.l.hasSensors)
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
    const requiredExtraRoomSensorProjection = defineProjection(
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

    expect(result.run.progress.sourceRowsSkipped).toBe(0)
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

    expect(objectResult.run.progress.sourceRowsRead).toBe(2)
    expect(objectResult.run.progress.sourceRowsSkipped).toBe(1)

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

    expect(linkResult.run.progress.sourceRowsRead).toBe(3)
    expect(linkResult.run.progress.sourceRowsSkipped).toBe(2)
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
    ).rejects.toBeInstanceOf(MaterializationValidationError)

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-invalid-property"),
    })
    expect(run?.status).toBe("failed")
    expect(run?.progress.sourceRowsRead).toBe(1)
    expect(run?.progress.sourceRowsSkipped).toBe(0)
    expect(run?.error?.message).toContain("must be one of")
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

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-int64-string",
        projectionId: "integer-device-proj",
        projectionKind: "object",
        datasetId: devicesDataset.id,
        versionId: version.versionId,
      },
    })

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
      id: canonicalRunId("projrun-unsafe-int64-string"),
    })
    expect(run?.status).toBe("failed")
    expect(run?.progress.sourceRowsRead).toBe(1)
    expect(run?.progress.sourceRowsSkipped).toBe(0)
    expect(run?.error?.message).toContain("cannot safely coerce")
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

    await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-fileref",
        projectionId: "document-proj",
        projectionKind: "object",
        datasetId: documentsDataset.id,
        versionId: version.versionId,
      },
    })

    const document = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Document",
      primaryId: "doc1",
    })
    expect(document?.properties.attachment).toEqual(attachment)
  })

  test("rejects a committed schema mismatch before claiming a run", async () => {
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
      id: canonicalRunId("projrun-schema-mismatch"),
    })
    expect(run).toBeNull()
  })

  test("rejects an unknown projection before claiming a run", async () => {
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
    ).rejects.toThrow("not registered")

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-unknown"),
    })
    expect(run).toBeNull()
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

  test("finishes a replacement whose ontology commit won a race with a late abort", async () => {
    const deps = createDeps()
    const abortController = new AbortController()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    const events = sixb.events as EventsRuntime
    const publish = events.publishEnvelopes.bind(events)
    let aborted = false
    events.publishEnvelopes = async (envelopes) => {
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

    const result = await runProjectionJob({
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

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-abort-final-flush"),
    })
    expect(result.run.status).toBe("succeeded")
    expect(run?.status).toBe("succeeded")
  })

  test("records explicit cancellation after claim without committing source state", async () => {
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
    const cancellation = new MaterializationCancellationError("Cancelled by test.")
    const abortController = new AbortController()
    abortController.abort(cancellation)
    let failuresReported = 0

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-explicit-cancellation",
          projectionId: "room-proj",
          projectionKind: "object",
          datasetId: roomsDataset.id,
          versionId: version.versionId,
        },
        signal: abortController.signal,
        onRunFailed: () => {
          failuresReported += 1
        },
      })
    ).rejects.toBe(cancellation)

    expect(failuresReported).toBe(0)
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-explicit-cancellation"),
      })
    ).toMatchObject({ status: "cancelled", progress: { sourceRowsRead: 0 } })
    expect(
      await deps.storage.ontology.commits.getByOrigin({
        projectId: sixb.id,
        origin: {
          kind: "projection",
          projectionRunId: canonicalRunId("projrun-explicit-cancellation"),
        },
      })
    ).toBeNull()
  })

  test("reclaims a run when terminal finalization failed after the durable commit", async () => {
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
    const restoreFinish = decorateOperationScopedMethodForTesting(
      deps.storage.projectionRuns,
      "finish",
      () => async () => Promise.reject(finishCause)
    )
    const input = {
      runtime,
      job: {
        id: "projrun-finish-fails",
        projectionId: "room-proj",
        projectionKind: "object" as const,
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    }

    await expect(runProjectionJob(input)).rejects.toBe(finishCause)
    const runId = canonicalRunId("projrun-finish-fails")
    expect(
      await deps.storage.projectionRuns.getById({ projectId: sixb.id, id: runId })
    ).toMatchObject({ status: "running", attempt: 1 })
    expect(
      await deps.storage.ontology.commits.getByOrigin({
        projectId: sixb.id,
        origin: { kind: "projection", projectionRunId: runId },
      })
    ).not.toBeNull()

    restoreFinish()
    await expect(runProjectionJob(input)).resolves.toMatchObject({
      run: { status: "succeeded", attempt: 2 },
      replayedTerminal: false,
    })
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

  test("rolls back the whole telemetry batch when one point has an invalid unit", async () => {
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
    ).rejects.toBeInstanceOf(MaterializationValidationError)

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-target-bad-unit"),
    })
    expect(run?.status).toBe("failed")
    expect(run?.progress.sourceRowsRead).toBe(0)
    expect(run?.error?.message).toContain("Invalid unit")

    // The fixed physical batch is atomic: no prefix of it is committed.
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "targetTemperature",
    })
    expect(history).toEqual([])
  })

  test("rejects an incompatible telemetry timestamp mapping before claiming a run", async () => {
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
      id: canonicalRunId("projrun-invalid-at"),
    })
    expect(run).toBeNull()
  })
})
