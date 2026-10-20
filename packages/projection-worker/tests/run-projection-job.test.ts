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
  SixbHost,
  stringEnum,
  valueTypeRef,
} from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import type { DomainEventService } from "@sixb/core/internal/events"
import { bindDurablePrimitiveExecution } from "@sixb/core/internal/primitive-execution"
import {
  createProjectionRunId,
  getProjectionRegistry,
  PROJECTION_TELEMETRY_BATCH_SIZE,
  type ProjectionDispatchDescriptor,
  projectionTargetOf,
  shareProjectionRegistry,
} from "@sixb/core/internal/projections"
import { registerOntologyMutationRuntime } from "@sixb/core/internal/runtime"
import { shareDatasetVersionMarkings } from "@sixb/core/internal/security"
import { decorateOperationScopedMethodForTesting } from "@sixb/core/internal/storage-operation-scope"
import type {
  BeginDatasetMergeInput,
  BeginDatasetWriteInput,
  ListLatestVersionsSinceInput,
  ReadDatasetRowsInput,
} from "@sixb/core/lake-storage"
import type {
  AbandonRunSourceMaterializationInput,
  AbandonSourceMaterializationCandidateInput,
  OntologySourceRecord,
  ProjectionRunRecord,
  ProjectionRunStorage,
} from "@sixb/core/storage"
import { createTestSixb, queueTestProjectionRun } from "@sixb/core/testing"
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
import type { ProjectionWorkerHost } from "../src/worker"

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
    prop("humidity", "double", { mode: "telemetry" }),
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

const groupedRoomReadingsDataset = defineDataset("canonical.grouped-room-readings", {
  schema: [
    col("room_id", "string"),
    col("observed_at", "timestamp"),
    col("temperature", "float64", { nullable: true }),
    col("humidity", "float64", { nullable: true }),
    col("target", "float64", { nullable: true }),
    col("target_unit", "string", { nullable: true }),
  ],
})

const groupedRoomReadingsProjection = defineProjection("grouped-room-readings-proj", Room)
  .fromDataset(groupedRoomReadingsDataset)
  .points({
    objectId: "room_id",
    at: "observed_at",
    properties: {
      temperature: "temperature",
      humidity: "humidity",
      targetTemperature: { value: "target", unit: "target_unit" },
    },
  })

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

  beginMerge(input: BeginDatasetMergeInput) {
    return this.delegate.beginMerge(input)
  }

  getLatestVersion(datasetId: string) {
    return this.delegate.getLatestVersion(datasetId)
  }

  getVersion(datasetId: string, versionId: string) {
    return this.delegate.getVersion(datasetId, versionId)
  }

  listLatestVersionsSince(input: ListLatestVersionsSinceInput) {
    return this.delegate.listLatestVersionsSince(input)
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
  failure: unknown = new Error("lake read interrupted")
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
        throw this.failure
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

function requireProjectionRunsStorage(input: {
  readonly storage: { readonly projectionRuns?: ProjectionRunStorage }
}): ProjectionRunStorage {
  const projectionRunsStorage = input.storage.projectionRuns
  if (!projectionRunsStorage) {
    throw new Error("Expected materialization-capable projection run storage in test runtime.")
  }
  return projectionRunsStorage
}

interface TestProjectionWorkerContext extends ProjectionWorkerContext {
  readonly host: ProjectionWorkerHost
}

function createRuntime(
  host: ProjectionWorkerHost,
  catalogs: Partial<Pick<ProjectionWorkerContext, "datasets" | "projections">> = {}
): TestProjectionWorkerContext {
  const runtime = {
    host,
    projectId: host.id,
    ontology: host.definitions.ontology,
    lakeStorage: host.lakeStorage,
    projectionRunsStorage: requireProjectionRunsStorage(host),
    datasets: catalogs.datasets ?? host.definitions.datasets,
    projections: catalogs.projections ?? host.definitions.projections,
  } satisfies TestProjectionWorkerContext
  shareProjectionRegistry(host, runtime)
  shareDatasetVersionMarkings(host, runtime)
  return runtime
}

async function bindRuntimeToRun(
  runtime: TestProjectionWorkerContext,
  run: ProjectionRunRecord
): Promise<TestProjectionWorkerContext> {
  const durableExecution = await runtime.host.storage.executions.getById({
    projectId: runtime.projectId,
    id: run.executionId,
  })
  if (!durableExecution) {
    throw new Error(`Projection run '${run.id}' references missing execution '${run.executionId}'.`)
  }
  const trustedPrimitive = {
    kind: "projection" as const,
    id: run.identity.projectionId,
    runId: run.id,
  }
  const execution = bindDurablePrimitiveExecution(runtime.host, {
    execution: durableExecution,
    primitive: trustedPrimitive,
  })
  const bound = { ...runtime }
  registerOntologyMutationRuntime(bound, execution.ontologyMutations)
  shareProjectionRegistry(runtime.host, bound)
  shareDatasetVersionMarkings(runtime.host, bound)
  return bound
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
  input: Omit<RunProjectionJobInput, "runtime" | "job"> & {
    readonly runtime: TestProjectionWorkerContext
    readonly job: LegacyTestProjectionJob
    readonly batchSize?: number
  }
): Promise<ProjectionJobResult> {
  const { id, identity } = await queueProjectionJob(input)
  const { batchSize, runtime, ...canonicalInput } = input
  const run = await runtime.projectionRunsStorage.getById({ projectId: runtime.projectId, id })
  if (!run) throw new Error(`Projection run '${id}' was not queued.`)
  return runCanonicalProjectionJob({
    ...canonicalInput,
    runtime: await bindRuntimeToRun(runtime, run),
    job: { id, ...identity },
    ...(batchSize === undefined ? {} : { telemetryBatchSize: batchSize }),
  })
}

/** Queues the job's durable run as dispatch would, unless it exists, without running it. */
async function queueProjectionJob(input: {
  readonly runtime: TestProjectionWorkerContext
  readonly job: LegacyTestProjectionJob
  readonly batchSize?: number
}): Promise<{ readonly id: string; readonly identity: ProjectionRunRecord["identity"] }> {
  const { runtime, batchSize } = input
  const registry = getProjectionRegistry(runtime)
  const version = await runtime.lakeStorage.getVersion(input.job.datasetId, input.job.versionId)
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
  const id = createProjectionRunId(runtime.projectId, identity)
  canonicalRunIds.set(input.job.id, id)
  const existing = await runtime.projectionRunsStorage.getById({
    projectId: runtime.projectId,
    id,
  })
  if (!existing) {
    const projection = runtime.projections.getById(input.job.projectionId)
    const target = projection
      ? projectionTargetOf(projection)
      : input.job.projectionKind === "link"
        ? { sourceObjectTypeId: "Unknown", targetObjectTypeId: "Unknown" }
        : { objectTypeId: "Unknown" }
    const common = {
      id,
      projectId: runtime.projectId,
      identity,
      target,
    }
    if (identity.projectionKind === "telemetry") {
      if (!("objectTypeId" in target)) throw new Error("Expected a telemetry object target.")
      await queueTestProjectionRun(runtime.host.storage, {
        ...common,
        identity,
        target,
        fixedBatchSize: batchSize ?? PROJECTION_TELEMETRY_BATCH_SIZE,
      })
    } else if (identity.projectionKind === "link") {
      if (!("sourceObjectTypeId" in target)) throw new Error("Expected a link target.")
      await queueTestProjectionRun(runtime.host.storage, { ...common, identity, target })
    } else {
      if (!("objectTypeId" in target)) throw new Error("Expected an object target.")
      await queueTestProjectionRun(runtime.host.storage, { ...common, identity, target })
    }
  }
  return { id, identity: identity as ProjectionRunRecord["identity"] }
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
  return new SixbHost({
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
  await waitForNextDatasetWatermark(lakeStorage, dataset.id)
  const write = await lakeStorage.beginWrite({
    dataset,
    mode: "snapshot",
    producer: { kind: "sync", id: "test-sync", runId: "sync-run-1" },
  })
  await write.writeRows(rows)
  return write.commit({ commitMessage: "test projection input" })
}

async function waitForNextDatasetWatermark(
  lakeStorage: LakeStorage,
  datasetId: string
): Promise<void> {
  const previous = await lakeStorage.getLatestVersion(datasetId)
  if (!previous) return
  // Replacement ordering deliberately rejects distinct versions with the same millisecond
  // watermark. Keep this fixture deterministic when in-memory commits happen back-to-back.
  await Bun.sleep(Math.max(0, previous.createdAt.getTime() + 1 - Date.now()))
}

describe("runProjectionJob", () => {
  test("classifies catalog policy and only terminal materialization conflicts as permanent", () => {
    expect(
      isPermanentProjectionFailure(
        createSixbError("internal.unexpected", "Projection invariant failed.")
      )
    ).toBe(true)
    expect(
      isPermanentProjectionFailure(
        createSixbError("dataset.version_read_inconsistent", "Dataset read was incomplete.")
      )
    ).toBe(false)
    expect(
      isPermanentProjectionFailure(
        createSixbError("projection.definition_invalid", "Projection definition is invalid.")
      )
    ).toBe(true)
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

  test("materializes telemetry from the exact dataset version, reading only mapped columns", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [roomsDataset, roomReadingsDataset],
        projections: [roomProjection, roomTemperatureProjection],
      },
      { ...deps, lakeStorage }
    )

    await createTestSixb(sixb)
      .objects(Room)
      .upsert({
        properties: { id: "r1", name: "Kitchen" },
      })
    // Rows out of timestamp order, one of them zone-less.
    const version1 = await commitDatasetVersion(lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-02 12:00:00",
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
    await commitDatasetVersion(lakeStorage, roomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-03T12:00:00.000Z",
        temperature: 75,
        sync_row_id: "reading-3",
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

    expect(result.run.progress.sourceRowsRead).toBe(2)
    expect(result.run.status).toBe("succeeded")
    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "observed_at", "temperature"])

    // The zone-less timestamp is UTC.
    const history = await deps.storage.timeseries.getHistory({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      propertyId: "temperature",
    })
    expect(history.map((point) => [point.at.toISOString(), point.value])).toEqual([
      ["2026-06-01T12:00:00.000Z", 70.5],
      ["2026-06-02T12:00:00.000Z", 72],
    ])

    // The object holds the value of the latest timestamp, not of the last row.
    const room = await deps.storage.objects.getByPrimaryId({
      projectId: sixb.id,
      objectTypeId: "Room",
      primaryId: "r1",
    })
    expect(room?.properties.temperature).toBe(72)
  })

  test("materializes grouped telemetry in one read while omitting only blank properties", async () => {
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      {
        datasets: [groupedRoomReadingsDataset],
        projections: [groupedRoomReadingsProjection],
      },
      { ...deps, lakeStorage }
    )
    await createTestSixb(sixb)
      .objects(Room)
      .upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(lakeStorage, groupedRoomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 20,
        humidity: 40,
        target: 21,
        target_unit: "degreeCelsius",
      },
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        temperature: 22,
        humidity: null,
        target: null,
        target_unit: null,
      },
      {
        room_id: "r1",
        observed_at: "2026-06-03T12:00:00.000Z",
        temperature: null,
        humidity: null,
        target: null,
        target_unit: "ignored-without-a-value",
      },
    ])

    const result = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-grouped-telemetry",
        projectionId: groupedRoomReadingsProjection.id,
        projectionKind: "telemetry",
        datasetId: groupedRoomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    expect(result.run).toMatchObject({
      status: "succeeded",
      progress: { sourceRowsRead: 3, sourceRowsSkipped: 1 },
    })
    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual([
      "room_id",
      "observed_at",
      "temperature",
      "humidity",
      "target",
      "target_unit",
    ])
    const history = (propertyId: string) =>
      deps.storage.timeseries.getHistory({
        projectId: sixb.id,
        objectTypeId: "Room",
        objectId: "r1",
        propertyId,
      })
    expect((await history("temperature")).map((point) => point.value)).toEqual([20, 22])
    expect((await history("humidity")).map((point) => point.value)).toEqual([40])
    expect(await history("targetTemperature")).toMatchObject([{ value: 21, unit: "degreeCelsius" }])
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
    await queueTestProjectionRun(sixb.storage, {
      id: job.id,
      projectId: sixb.id,
      identity,
      target: { objectTypeId: Room.id },
    })
    const run = await runtime.projectionRunsStorage.getById({
      projectId: runtime.projectId,
      id: job.id,
    })
    if (!run) throw new Error(`Projection run '${job.id}' was not queued.`)
    const boundRuntime = await bindRuntimeToRun(runtime, run)
    await runCanonicalProjectionJob({ runtime: boundRuntime, job })

    const unavailable = () => {
      throw new Error("terminal replay accessed current configuration or lake state")
    }
    const replayRuntime: ProjectionWorkerContext = {
      ...boundRuntime,
      lakeStorage: new Proxy(boundRuntime.lakeStorage, { get: unavailable }),
      datasets: { getById: unavailable },
      projections: { getById: unavailable },
    }

    await expect(runCanonicalProjectionJob({ runtime: replayRuntime, job })).resolves.toMatchObject(
      {
        run: { id: job.id, status: "succeeded" },
        replayedTerminal: true,
      }
    )
  })

  test("rejects a noncanonical run id with a coded identity error", async () => {
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
    const expectedRunId = createProjectionRunId(sixb.id, identity)
    const error = await runCanonicalProjectionJob({
      runtime: createRuntime(sixb),
      job: { id: "not-the-canonical-run-id", ...identity },
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      code: "projection.run_identity_mismatch",
      retryable: false,
      message: expect.stringContaining("does not match its pinned semantic identity"),
      details: {
        projectionId: roomProjection.id,
        runId: "not-the-canonical-run-id",
        identityMismatches: [
          {
            field: "runId",
            expected: expectedRunId,
            actual: "not-the-canonical-run-id",
          },
        ],
      },
    })
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: expectedRunId,
      })
    ).toBeNull()
  })

  // Reverting the worker to finish such a run through projection run storage directly (as it did
  // before materialization began) leaves this candidate staging forever.
  test("reports only differing identity fields and releases a candidate an earlier delivery left", async () => {
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
      // Pinned before a deploy changed the projection.
      projectionRevision: "revision-before-deploy",
      ownershipHash: descriptor.ownershipHash,
    }
    const runId = createProjectionRunId(sixb.id, identity)
    const run = await queueTestProjectionRun(deps.storage, {
      id: runId,
      projectId: sixb.id,
      identity,
      target: { objectTypeId: Room.id },
    })
    const earlier = await deps.storage.projectionRuns.startOrReclaim({
      id: runId,
      projectId: sixb.id,
      identity,
      target: { objectTypeId: Room.id },
    })
    await deps.storage.ontology.sources.beginMaterialization({
      projectId: sixb.id,
      source: { projectionId: roomProjection.id },
      materializationId: "left-by-earlier-delivery",
      execution: earlier.execution,
      projectionKind: "object",
      protocol: "replacement",
      datasetVersion: identity.datasetVersion,
      projectionRevision: identity.projectionRevision,
      ownershipHash: identity.ownershipHash,
      ontologyRevision: identity.ontologyRevision,
      createdAt: new Date().toISOString(),
    })

    const error = await runCanonicalProjectionJob({
      runtime: await bindRuntimeToRun(createRuntime(sixb), run),
      job: { id: runId, ...identity },
    }).catch((caught: unknown) => caught)

    // Only the fields that differ from the registry are reported.
    expect(error).toMatchObject({
      code: "projection.run_identity_mismatch",
      retryable: false,
      details: {
        projectionId: roomProjection.id,
        runId,
        identityMismatches: [
          {
            field: "projectionRevision",
            expected: "revision-before-deploy",
            actual: descriptor.projectionRevision,
          },
        ],
      },
    })

    expect(
      await deps.storage.projectionRuns.getById({ projectId: sixb.id, id: runId })
    ).toMatchObject({ status: "failed", attempt: 2 })
    // The only terminal source version is the abandoned candidate.
    expect(
      await deps.storage.ontology.sources.purgeAbandoned({ projectId: sixb.id, limit: 1_000 })
    ).toMatchObject({ materializationsDeleted: 1 })
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
    await createTestSixb(sixb)
      .objects(Room)
      .upsert({ properties: { id: "r1", name: "Kitchen" } })
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
    await createTestSixb(sixb)
      .objects(Room)
      .upsert({ properties: { id: "r1", name: "Kitchen" } })
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
    const readError = await runProjectionJob(input).catch((error: unknown) => error)
    expect(readError).toMatchObject({
      code: "dataset.version_read_inconsistent",
      retryable: true,
      message: expect.stringContaining("reached EOF after 2 of 3 pinned rows"),
      details: {
        projectionId: roomTemperatureProjection.id,
        runId: canonicalRunId(input.job.id),
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
        expectedRows: 3,
        rowsRead: 2,
      },
    })
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

  test("telemetry projections keep the last value written at an instant, across and within versions", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomReadingsDataset],
        projections: [roomTemperatureProjection],
      },
      deps
    )
    await createTestSixb(sixb)
      .objects(Room)
      .upsert({
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
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 72,
        sync_row_id: "reading-2",
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

    // Same (object, property, instant): the newer version overwrites, and within one version the
    // later row does.
    expect(second.run.status).toBe("succeeded")

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
    expect(history.map((point) => point.value)).toEqual([72])
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
    await createTestSixb(sixb)
      .objects(Room)
      .upsert({
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
    // leaves the run retryable however old the run itself is: the clock is far past the run's
    // start, which is how the grace used to be measured, and a batched projection commits for
    // minutes before reaching the batch that cannot.
    const startedWaitingAt = Date.now() + MISSING_TARGET_GRACE_MS * 10
    const deliver = (now: number) =>
      runProjectionJob({ runtime: createRuntime(sixb), batchSize: 10, now: () => now, job })
    await expect(deliver(startedWaitingAt)).rejects.toThrow("missing object")

    // Left running, which is what the queue reads as "redeliver me": the worker retries a run it
    // finds still running and refuses to retry one recorded as failed. A telemetry projection and
    // the object projection feeding it are queued from separate dataset versions and nothing
    // sequences them, so failing on the first delivery turned a wait of milliseconds into a
    // permanent hole.
    expect(await readRun()).toMatchObject({
      status: "running",
      missingTarget: { objectTypeId: "Room", objectId: "missing-room", batchOrdinal: 0 },
    })
    await expect(deliver(startedWaitingAt + MISSING_TARGET_GRACE_MS - 1)).rejects.toThrow(
      "missing object"
    )
    expect(await readRun()).toMatchObject({ status: "running" })

    // A later delivery, past the grace, finds the same object at the same batch: the source
    // names something the ontology does not have, not something merely early.
    await expect(deliver(startedWaitingAt + MISSING_TARGET_GRACE_MS)).rejects.toThrow(
      "missing object"
    )

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

    await createTestSixb(sixb)
      .objects(Room)
      .upsert({ properties: { id: "late-room", name: "Late" } })
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

  test("object projections read only mapped columns and tolerate required unmapped ones", async () => {
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

  test("atomically reassigns cardinality-one FK links", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    await createTestSixb(sixb).objects.upsert("Building", { id: "b1", name: "Old HQ" })
    await createTestSixb(sixb).objects.upsert("Building", { id: "b2", name: "New HQ" })
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
    const readError = await runProjectionJob(input).catch((error: unknown) => error)
    expect(readError).toMatchObject({
      code: "dataset.version_read_inconsistent",
      retryable: true,
      message: expect.stringContaining("persisted progress floor"),
      details: {
        projectionId: roomProjection.id,
        runId: canonicalRunId(input.job.id),
        datasetId: roomsDataset.id,
        versionId: nextVersion.versionId,
        persistedRowsRead: 2,
        persistedRowsSkipped: 0,
        rowsRead: 1,
        rowsSkipped: 0,
      },
    })
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

  test("supersedes a run of an older version without reading it once a later one is queued", async () => {
    // Removal proof: make `supersedeStaleRun` return false; the stale rows are materialized.
    const deps = createDeps()
    const lakeStorage = new RecordingLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      { datasets: [roomsDataset], projections: [roomProjection] },
      { ...deps, lakeStorage }
    )
    const stale = await commitDatasetVersion(lakeStorage, roomsDataset, [
      { room_id: "stale", room_name: "Stale room", building_ref: null },
    ])
    const latest = await commitDatasetVersion(lakeStorage, roomsDataset, [
      { room_id: "latest", room_name: "Latest room", building_ref: null },
    ])
    const runtime = createRuntime(sixb)
    const job = (id: string, versionId: string) => ({
      id,
      projectionId: roomProjection.id,
      projectionKind: "object" as const,
      datasetId: roomsDataset.id,
      versionId,
    })
    await queueProjectionJob({ runtime, job: job("projrun-latest", latest.versionId) })

    const superseded = await runProjectionJob({
      runtime,
      job: job("projrun-stale", stale.versionId),
    })

    expect(superseded).toMatchObject({
      replayedTerminal: false,
      run: { status: "superseded", attempt: 1 },
    })
    expect(superseded.run.error).toBeUndefined()
    expect(lakeStorage.readInputs).toEqual([])
    await expect(
      runProjectionJob({ runtime, job: job("projrun-stale", stale.versionId) })
    ).resolves.toMatchObject({ replayedTerminal: true, run: { status: "superseded" } })

    await runProjectionJob({ runtime, job: job("projrun-latest", latest.versionId) })
    const room = (primaryId: string) =>
      deps.storage.objects.getByPrimaryId({ projectId: sixb.id, objectTypeId: Room.id, primaryId })
    expect(await room("stale")).toBeNull()
    expect(await room("latest")).toMatchObject({ properties: { name: "Latest room" } })
  })

  test("keeps the failure of each retried attempt until the run recovers", async () => {
    // Removal proof: drop `recordAttemptFailure` from the transient branch; the error stays unset.
    const deps = createDeps()
    const lakeStorage = new InterruptibleLakeStorage(deps.lakeStorage)
    const sixb = createSixb(
      { datasets: [roomsDataset], projections: [roomProjection] },
      { ...deps, lakeStorage }
    )
    const version = await commitDatasetVersion(lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen", building_ref: null },
      { room_id: "r2", room_name: "Office", building_ref: null },
    ])
    const input = {
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-retried",
        projectionId: roomProjection.id,
        projectionKind: "object" as const,
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    }
    const run = () =>
      deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId(input.job.id),
      })

    lakeStorage.failAfterRows = 1
    await expect(runProjectionJob(input)).rejects.toThrow("lake read interrupted")
    expect(await run()).toMatchObject({
      status: "running",
      attempt: 1,
      error: { code: "projection.execution_failed", message: "Projection execution failed." },
    })

    const unavailable = createSixbError("storage.unavailable", "PostgreSQL is unavailable.")
    lakeStorage.failure = unavailable
    await expect(runProjectionJob(input)).rejects.toBe(unavailable)
    expect(await run()).toMatchObject({
      status: "running",
      attempt: 2,
      error: {
        code: "storage.unavailable",
        message: "Storage is temporarily unavailable.",
        retryable: true,
      },
    })

    lakeStorage.failAfterRows = undefined
    await runProjectionJob(input)
    const recovered = await run()
    expect(recovered).toMatchObject({ status: "succeeded", attempt: 3 })
    expect(recovered?.error).toBeUndefined()
  })

  test("keeps the run running when its candidate cannot be released with it", async () => {
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
        function failRunRelease(
          input: AbandonSourceMaterializationCandidateInput
        ): Promise<OntologySourceRecord>
        function failRunRelease(
          input: AbandonRunSourceMaterializationInput
        ): Promise<OntologySourceRecord | null>
        async function failRunRelease(
          input: AbandonSourceMaterializationCandidateInput | AbandonRunSourceMaterializationInput
        ): Promise<OntologySourceRecord | null> {
          // The run ends in the same transaction as the release, so it cannot end without it.
          if (input.kind === "run") throw abandonmentFailure
          return abandon(input)
        }
        return failRunRelease
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

  test("fails the run on repetitions of the same object root instead of merging them", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjectionWithFk],
      },
      deps
    )
    for (const buildingId of ["b1", "b2"]) {
      await createTestSixb(sixb).objects.upsert("Building", { id: buildingId, name: buildingId })
    }

    const events = sixb.events as DomainEventService
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
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-repeated-edge"),
      })
    ).toMatchObject({ status: "failed", progress: { sourceRowsRead: 3 } })

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
    await createTestSixb(sixb).objects.upsert("Building", { id: "b1", name: "HQ" })
    for (const roomId of ["r1", "r2"]) {
      await createTestSixb(sixb).objects.upsert("Room", {
        id: roomId,
        name: roomId,
        buildingRef: "b1",
      })
      await createTestSixb(sixb).objects.upsertLink("Room", roomId, "inBuilding", {
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
    await createTestSixb(sixb).objects.upsert("Building", { id: "b1", name: "HQ" })
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

  test("materializes a link projection reading only its source and target columns", async () => {
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
    await createTestSixb(sixb).objects.upsert("Room", { id: "r1", name: "Kitchen" })
    await createTestSixb(sixb).objects.upsert("Sensor", { id: "s1", name: "Motion" })
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

    // A required column the projection does not map is neither read nor a reason to skip rows.
    expect(result.run.progress).toMatchObject({ sourceRowsRead: 1, sourceRowsSkipped: 0 })
    expect(lakeStorage.readInputs).toHaveLength(1)
    expect(lakeStorage.readInputs[0]?.columns).toEqual(["room_id", "sensor_id"])
    const links = await deps.storage.objects.listLinks({
      projectId: sixb.id,
      objectTypeId: "Room",
      objectId: "r1",
      linkId: "hasSensors",
    })
    expect(links.map((row) => row.targetId)).toEqual(["s1"])
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

    await createTestSixb(objectSixb).objects.upsert("Room", { id: "r1", name: "Kitchen" })
    await createTestSixb(objectSixb).objects.upsert("Sensor", { id: "s1", name: "Motion" })
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
    const sixb = new SixbHost({
      id: "projection-worker-tests",
      ontology: [Device],
      ...deps,
      datasets: [devicesDataset],
      projections: [deviceProjection],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, devicesDataset, [
      { device_id: "d1", device_status: "offline" },
    ])

    const job = {
      id: "projrun-invalid-property",
      projectionId: "device-proj",
      projectionKind: "object" as const,
      datasetId: "canonical.devices",
      versionId: version.versionId,
    }
    await expect(runProjectionJob({ runtime: createRuntime(sixb), job })).rejects.toBeInstanceOf(
      MaterializationValidationError
    )

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-invalid-property"),
    })
    expect(run?.status).toBe("failed")
    expect(run?.progress.sourceRowsRead).toBe(1)
    expect(run?.progress.sourceRowsSkipped).toBe(0)
    expect(run?.error).toMatchObject({
      code: "projection.execution_failed",
      message:
        "Projection execution failed. Property Device.status must match a declared enum value.",
      retryable: false,
      details: {
        projectionId: "device-proj",
        runId: canonicalRunId("projrun-invalid-property"),
        datasetId: devicesDataset.id,
        versionId: version.versionId,
      },
    })
    expect(run?.error?.at).toBe(run?.finishedAt?.toISOString())

    const terminalError = await runProjectionJob({
      runtime: createRuntime(sixb),
      job,
    }).catch((caught: unknown) => caught)
    expect(terminalError).toMatchObject({
      code: "projection.run_already_terminal",
      retryable: false,
      message: expect.stringContaining("is already 'failed'"),
      details: {
        projectionId: deviceProjection.id,
        runId: canonicalRunId(job.id),
        datasetId: devicesDataset.id,
        versionId: version.versionId,
        status: "failed",
      },
    })
  })

  test("fails a run whose objects share a unique value and names both", async () => {
    const Person = defineObjectType({
      id: "Person",
      name: "Person",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("email", "string", { unique: true }),
      ],
    })
    const peopleDataset = defineDataset("canonical.people", {
      schema: [col("person_id", "string"), col("person_email", "string")],
    })
    const peopleProjection = defineProjection("people-proj", Person)
      .fromDataset(peopleDataset)
      .properties({ id: "person_id", email: "person_email" })
    const deps = createDeps()
    const sixb = new SixbHost({
      id: "projection-worker-tests",
      ontology: [Person],
      ...deps,
      datasets: [peopleDataset],
      projections: [peopleProjection],
    })
    const version = await commitDatasetVersion(deps.lakeStorage, peopleDataset, [
      { person_id: "p-1", person_email: "same@example.com" },
      { person_id: "p-2", person_email: "same@example.com" },
    ])

    const job = {
      id: "projrun-unique-duplicate",
      projectionId: "people-proj",
      projectionKind: "object" as const,
      datasetId: peopleDataset.id,
      versionId: version.versionId,
    }
    await expect(runProjectionJob({ runtime: createRuntime(sixb), job })).rejects.toBeInstanceOf(
      MaterializationValidationError
    )

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId(job.id),
    })
    expect(run?.status).toBe("failed")
    expect(run?.error).toMatchObject({
      code: "projection.execution_failed",
      message:
        "Projection execution failed. Objects 'p-1' and 'p-2' of 'Person' have the same 'email', which must be unique.",
    })
    expect(
      await deps.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: Person.id,
        primaryId: "p-1",
      })
    ).toBeNull()
  })

  test("preserves coded internal errors raised after the run is claimed", async () => {
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
    const testRunId = "projrun-coded-invariant"
    let invariant: unknown
    deps.lakeStorage.readRows = () => ({
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            invariant = createSixbError(
              "internal.unexpected",
              "[SixbProjectionWorker] Projection execution state is inconsistent.",
              {
                details: {
                  projectionId: roomProjection.id,
                  runId: canonicalRunId(testRunId),
                },
              }
            )
            throw invariant
          },
        }
      },
    })

    const caught = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: testRunId,
        projectionId: roomProjection.id,
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    }).catch((error: unknown) => error)

    expect(caught).toBe(invariant)
    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId(testRunId),
    })
    expect(run).toMatchObject({
      status: "failed",
      error: {
        code: "internal.unexpected",
        retryable: false,
        message: "An unexpected internal error occurred.",
        details: {
          projectionId: roomProjection.id,
          runId: canonicalRunId(testRunId),
        },
      },
    })
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
    const sixb = new SixbHost({
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
    const sixb = new SixbHost({
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
    expect(run?.error).toMatchObject({
      code: "projection.execution_failed",
      message: "Projection execution failed.",
      retryable: false,
      details: {
        projectionId: deviceProjection.id,
        runId: canonicalRunId("projrun-unsafe-int64-string"),
        datasetId: devicesDataset.id,
        versionId: version.versionId,
      },
    })
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
    const sixb = new SixbHost({
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

  test("records a committed schema mismatch on the claimed durable run", async () => {
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

    const error = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-schema-mismatch",
        projectionId: "room-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "dataset.version_incompatible",
      retryable: false,
      message: expect.stringContaining("schema mismatch"),
      details: {
        projectionId: roomProjection.id,
        runId: canonicalRunId("projrun-schema-mismatch"),
        datasetId: roomsDataset.id,
        versionId: version.versionId,
        columnName: "room_name",
        expectedColumn: "'room_name:string'",
        actualColumn: "a missing column",
      },
    })

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-schema-mismatch"),
    })
    expect(run).toMatchObject({
      status: "failed",
      attempt: 1,
      error: {
        code: "projection.execution_failed",
        message: "Projection execution failed. Dataset version is incompatible.",
        retryable: false,
      },
    })
  })

  test("fails a claimed run when its Projection is no longer registered", async () => {
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

    const error = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-unknown",
        projectionId: "missing-proj",
        projectionKind: "object",
        datasetId: "canonical.rooms",
        versionId: version.versionId,
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "projection.not_found",
      retryable: false,
      message: expect.stringContaining("not registered"),
      details: {
        projectionId: "missing-proj",
        runId: canonicalRunId("projrun-unknown"),
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    })

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-unknown"),
    })
    expect(run).toMatchObject({
      status: "failed",
      attempt: 1,
      error: {
        code: "projection.execution_failed",
        message: "Projection execution failed. Projection not found.",
        retryable: false,
      },
    })
  })

  test("rejects a runtime-missing dataset with the shared dataset code", async () => {
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
    const runtime = createRuntime(sixb, {
      datasets: {
        getById: () => null,
      },
    })

    const error = await runProjectionJob({
      runtime,
      job: {
        id: "projrun-unknown-dataset",
        projectionId: roomProjection.id,
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: version.versionId,
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "dataset.not_found",
      retryable: false,
      message: expect.stringContaining("references unknown dataset"),
      details: {
        projectionId: roomProjection.id,
        runId: canonicalRunId("projrun-unknown-dataset"),
        datasetId: roomsDataset.id,
        versionId: version.versionId,
        source: "runtime",
      },
    })
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-unknown-dataset"),
      })
    ).toMatchObject({
      status: "failed",
      attempt: 1,
      error: {
        code: "projection.execution_failed",
        message: "Projection execution failed. Dataset not found.",
        retryable: false,
      },
    })
  })

  test("rejects a missing pinned version with the shared version code", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [roomsDataset],
        projections: [roomProjection],
      },
      deps
    )
    await deps.lakeStorage.createDataset(roomsDataset)

    const error = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-unknown-version",
        projectionId: roomProjection.id,
        projectionKind: "object",
        datasetId: roomsDataset.id,
        versionId: "missing-version",
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "dataset.version_not_found",
      retryable: false,
      message: expect.stringContaining("version 'missing-version' was not found"),
      details: {
        projectionId: roomProjection.id,
        runId: canonicalRunId("projrun-unknown-version"),
        datasetId: roomsDataset.id,
        versionId: "missing-version",
      },
    })
    expect(
      await deps.storage.projectionRuns.getById({
        projectId: sixb.id,
        id: canonicalRunId("projrun-unknown-version"),
      })
    ).toMatchObject({
      status: "failed",
      attempt: 1,
      error: {
        code: "projection.execution_failed",
        message: "Projection execution failed. Dataset version not found.",
        retryable: false,
      },
    })
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
    const events = sixb.events as DomainEventService
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
    const cancelledRun = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-explicit-cancellation"),
    })
    expect(cancelledRun).toMatchObject({
      status: "cancelled",
      progress: { sourceRowsRead: 0 },
      error: {
        code: "runtime.cancelled",
        message: "Execution was cancelled.",
        retryable: false,
        details: {
          projectionId: "room-proj",
          runId: canonicalRunId("projrun-explicit-cancellation"),
        },
      },
    })
    expect(cancelledRun?.error?.at).toBe(cancelledRun?.finishedAt?.toISOString())
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

  test("rolls back every property of the whole telemetry batch when one value is invalid", async () => {
    const deps = createDeps()
    const sixb = createSixb(
      {
        datasets: [groupedRoomReadingsDataset],
        projections: [groupedRoomReadingsProjection],
      },
      deps
    )

    await createTestSixb(sixb)
      .objects(Room)
      .upsert({ properties: { id: "r1", name: "Kitchen" } })
    const version = await commitDatasetVersion(deps.lakeStorage, groupedRoomReadingsDataset, [
      {
        room_id: "r1",
        observed_at: "2026-06-01T12:00:00.000Z",
        temperature: 20,
        humidity: 40,
        target: 21,
        target_unit: "degreeCelsius",
      },
      {
        room_id: "r1",
        observed_at: "2026-06-02T12:00:00.000Z",
        temperature: 22,
        humidity: 41,
        target: 22,
        target_unit: "bananas", // not a Temperature unit -> OntologyValidationError at append time
      },
    ])

    await expect(
      runProjectionJob({
        runtime: createRuntime(sixb),
        job: {
          id: "projrun-target-bad-unit",
          projectionId: groupedRoomReadingsProjection.id,
          projectionKind: "telemetry",
          datasetId: groupedRoomReadingsDataset.id,
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
    expect(run?.error).toMatchObject({
      code: "projection.execution_failed",
      message: "Projection execution failed.",
      retryable: false,
      details: {
        projectionId: groupedRoomReadingsProjection.id,
        runId: canonicalRunId("projrun-target-bad-unit"),
        datasetId: groupedRoomReadingsDataset.id,
        versionId: version.versionId,
      },
    })

    // The fixed physical batch is atomic: no prefix of it is committed, for any property.
    for (const propertyId of ["temperature", "humidity", "targetTemperature"]) {
      expect(
        await deps.storage.timeseries.getHistory({
          projectId: sixb.id,
          objectTypeId: "Room",
          objectId: "r1",
          propertyId,
        })
      ).toEqual([])
    }
  })

  test("records an incompatible telemetry timestamp mapping on the durable run", async () => {
    const deps = createDeps()
    const invalidAtProjection = {
      _tag: "TelemetryProjectionDefinition",
      id: "room-invalid-at-proj",
      objectTypeId: "Room",
      datasetId: roomReadingsDataset.id,
      objectIdField: "room_id",
      atField: "temperature", // float64 column, not date-like
      properties: { temperature: { valueField: "temperature" } },
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

    const error = await runProjectionJob({
      runtime: createRuntime(sixb),
      job: {
        id: "projrun-invalid-at",
        projectionId: "room-invalid-at-proj",
        projectionKind: "telemetry",
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
      },
    }).catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "projection.definition_invalid",
      retryable: false,
      message: expect.stringContaining("must be a string, date, or timestamp"),
      details: {
        projectionId: "room-invalid-at-proj",
        runId: canonicalRunId("projrun-invalid-at"),
        datasetId: roomReadingsDataset.id,
        versionId: version.versionId,
        objectTypeId: Room.id,
        columnName: "temperature",
        columnType: "float64",
      },
    })

    const run = await deps.storage.projectionRuns.getById({
      projectId: sixb.id,
      id: canonicalRunId("projrun-invalid-at"),
    })
    expect(run).toMatchObject({
      status: "failed",
      attempt: 1,
      error: {
        code: "projection.execution_failed",
        message: "Projection execution failed. Projection definition is invalid.",
        retryable: false,
      },
    })
  })
})
