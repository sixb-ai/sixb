import { describe, expect, test } from "bun:test"
import { AuthorizationError, emptyGrantIndex } from "../src/authorization"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import {
  createDelegatedRequestScope,
  createPrincipalRequestScope,
  createTestingScope,
} from "../src/execution/scopes"
import type { ExecutionScope } from "../src/execution/types"
import { getLatestTelemetryPoint, getTelemetryHistoryBatch } from "../src/objects/telemetry/history"
import { defineObjectType, OntologyRegistry, prop } from "../src/ontology"
import type {
  ObjectReadStorage,
  ObjectStorage,
  TimeseriesHistoryBatchInput,
  TimeseriesHistoryBatchResult,
  TimeseriesHistorySeriesInput,
  TimeseriesPoint,
  TimeseriesStorage,
} from "../src/storage"
import {
  getInMemoryObjectMaterializerAdapter,
  InMemoryObjectStorage,
} from "../src/storage/objects/in-memory"

const projectId = "telemetry-history"
const at = new Date("2026-01-01T00:00:00.000Z")

const Sensor = defineObjectType({
  id: "TelemetrySensor",
  name: "Telemetry sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry" }),
    prop("humidity", "double", { mode: "telemetry" }),
  ],
})

const Secret = defineObjectType({
  id: "TelemetrySecret",
  name: "Telemetry secret",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("reading", "double", { mode: "telemetry" }),
  ],
})

const ontology = new OntologyRegistry({ sources: [Sensor, Secret] })

describe("telemetry history admission", () => {
  test("derives project identity from the reader and preserves principal historical reads", async () => {
    const objectStorage = new InMemoryObjectStorage()
    let objectSelectionCalls = 0
    const originalSelection = objectStorage.selectsObjectProperties.bind(objectStorage)
    objectStorage.selectsObjectProperties = async (input) => {
      objectSelectionCalls += 1
      return originalSelection(input)
    }
    const reader = createAuthorizedObjectReader({
      scope: principalScope(),
      ontology,
      objectStorage,
    })
    const requestedProjects: string[] = []
    const storage = timeseriesStorage({
      getHistoryBatch: async (input) => {
        requestedProjects.push(input.projectId)
        return input.series.map((series) => ({ ...series, points: [point(series)] }))
      },
    })
    const series = sensorSeries("deleted-sensor", "temperature")

    await expect(
      getTelemetryHistoryBatch(
        { projectId: "forged-project", series: [series] } as TimeseriesHistoryBatchInput,
        { storage, objectReader: reader }
      )
    ).resolves.toEqual([{ ...series, points: [point(series)] }])
    expect(requestedProjects).toEqual([projectId])
    expect(objectSelectionCalls).toBe(0)
  })

  test("reads only exact selected object properties and preserves duplicate alignment", async () => {
    const objectStorage = seededObjectStorage(["sensor-1", "sensor-2"])
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({
        roots: [selectedRoot("sensor-1", ["id", "temperature"]), selectedRoot("sensor-2", ["id"])],
      }),
      ontology,
      objectStorage,
    })
    const providerSeries: TimeseriesHistorySeriesInput[][] = []
    let latestCalls = 0
    const storage = timeseriesStorage({
      getHistoryBatch: async (input) => {
        providerSeries.push([...input.series])
        return input.series.map((series) => ({ ...series, points: [point(series)] }))
      },
      getLatest: async (input) => {
        latestCalls += 1
        return point(input)
      },
    })
    const visible = sensorSeries("sensor-1", "temperature")
    const hiddenProperty = sensorSeries("sensor-2", "temperature")
    const hiddenSibling = sensorSeries("sensor-3", "temperature")

    await expect(
      getTelemetryHistoryBatch(
        { series: [visible, visible, hiddenProperty, hiddenSibling], limitPerSeries: 1 },
        { storage, objectReader: reader }
      )
    ).resolves.toEqual([
      { ...visible, points: [point(visible)] },
      { ...visible, points: [point(visible)] },
      { ...hiddenProperty, points: [] },
      { ...hiddenSibling, points: [] },
    ])
    expect(providerSeries).toEqual([[visible]])

    await expect(
      getLatestTelemetryPoint(hiddenSibling, { storage, objectReader: reader })
    ).resolves.toBeNull()
    expect(latestCalls).toBe(0)
    await expect(
      getLatestTelemetryPoint(visible, { storage, objectReader: reader })
    ).resolves.toEqual(point(visible))
    expect(latestCalls).toBe(1)
  })

  test("denies an unselected type before timeseries storage", async () => {
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({ roots: [selectedRoot("sensor-1", ["id", "temperature"])] }),
      ontology,
      objectStorage: seededObjectStorage(["sensor-1"]),
    })
    let historyCalls = 0
    const storage = timeseriesStorage({
      getHistoryBatch: async () => {
        historyCalls += 1
        return []
      },
    })

    await expect(
      getTelemetryHistoryBatch(
        {
          series: [{ objectTypeId: Secret.id, objectId: "secret-1", propertyId: "reading" }],
        },
        { storage, objectReader: reader }
      )
    ).rejects.toBeInstanceOf(AuthorizationError)
    expect(historyCalls).toBe(0)
  })

  test("revalidates live selection after history and latest provider reads", async () => {
    let selectionChecks = 0
    const selectedReader = {
      selectsObjectProperties: async (
        input: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
      ) => {
        selectionChecks += 1
        return input.items.map(() => selectionChecks % 2 === 1)
      },
    } as unknown as ObjectReadStorage
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({ roots: [selectedRoot("sensor-1", ["id", "temperature"])] }),
      ontology,
      objectStorage: selectedStorageFactory(selectedReader),
    })
    const series = sensorSeries("sensor-1", "temperature")
    let historyCalls = 0
    let latestCalls = 0
    const storage = timeseriesStorage({
      getHistoryBatch: async () => {
        historyCalls += 1
        return [{ ...series, points: [point(series)] }]
      },
      getLatest: async () => {
        latestCalls += 1
        return point(series)
      },
    })

    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage, objectReader: reader }
      )
    ).resolves.toEqual([{ ...series, points: [] }])
    expect(historyCalls).toBe(1)

    await expect(
      getLatestTelemetryPoint(series, { storage, objectReader: reader })
    ).resolves.toBeNull()
    expect(latestCalls).toBe(1)
    expect(selectionChecks).toBe(4)
  })

  test("normalizes provider-owned values before the final live selection check", async () => {
    let selected = true
    const selectedReader = {
      selectsObjectProperties: async (
        input: Parameters<ObjectReadStorage["selectsObjectProperties"]>[0]
      ) => input.items.map(() => selected),
    } as unknown as ObjectReadStorage
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({ roots: [selectedRoot("sensor-1", ["id", "temperature"])] }),
      ontology,
      objectStorage: selectedStorageFactory(selectedReader),
    })
    const series = sensorSeries("sensor-1", "temperature")
    const revokeWhileSnapshotting = <T>(value: T): T => {
      selected = false
      return value
    }
    const historyResult = Object.defineProperties(
      { ...series },
      {
        points: {
          enumerable: true,
          get: () => revokeWhileSnapshotting([point(series)]),
        },
      }
    ) as TimeseriesHistoryBatchResult
    const latestResult = Object.defineProperty(point(series), "value", {
      enumerable: true,
      get: () => revokeWhileSnapshotting(21),
    })
    const storage = timeseriesStorage({
      getHistoryBatch: async () => [historyResult],
      getLatest: async () => latestResult,
    })

    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage, objectReader: reader }
      )
    ).resolves.toEqual([{ ...series, points: [] }])

    selected = true
    await expect(
      getLatestTelemetryPoint(series, { storage, objectReader: reader })
    ).resolves.toBeNull()
  })

  test("never shares its canonical series snapshot with the provider", async () => {
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({ roots: [selectedRoot("sensor-1", ["id", "temperature"])] }),
      ontology,
      objectStorage: seededObjectStorage(["sensor-1"]),
    })
    const series = sensorSeries("sensor-1", "temperature")
    const storage = timeseriesStorage({
      getHistoryBatch: async (input) => {
        Object.defineProperty(input.series[0]!, "objectId", { value: "sensor-2" })
        return [{ ...series, points: [point(series)] }]
      },
    })

    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage, objectReader: reader }
      )
    ).resolves.toEqual([{ ...series, points: [point(series)] }])
  })

  test("rejects provider results outside the requested project, series, or limit", async () => {
    const reader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId }),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const series = sensorSeries("sensor-1", "temperature")
    const other = sensorSeries("sensor-2", "temperature")

    const wrongPoint = timeseriesStorage({
      getHistoryBatch: async () => [
        { ...series, points: [{ ...point(series), projectId: "foreign-project" }] },
      ],
    })
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage: wrongPoint, objectReader: reader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })

    const extraSeries = timeseriesStorage({
      getHistoryBatch: async () => [{ ...other, points: [] }],
    })
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage: extraSeries, objectReader: reader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })

    const duplicateSeries = timeseriesStorage({
      getHistoryBatch: async () => [
        { ...series, points: [] },
        { ...series, points: [] },
      ],
    })
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage: duplicateSeries, objectReader: reader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })

    const tooManyPoints = timeseriesStorage({
      getHistoryBatch: async () => [{ ...series, points: [point(series)] }],
    })
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 0 },
        { storage: tooManyPoints, objectReader: reader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })

    const wrongLatest = timeseriesStorage({
      getLatest: async () => ({ ...point(series), objectId: "sensor-2" }),
    })
    await expect(
      getLatestTelemetryPoint(series, { storage: wrongLatest, objectReader: reader })
    ).rejects.toMatchObject({ code: "internal.unexpected" })
  })

  test("captures hostile capabilities and request fields once", async () => {
    const reader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId }),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const foreignReader = createAuthorizedObjectReader({
      scope: createTestingScope({ projectId: "foreign-project" }),
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const requestedProjects: string[] = []
    const storage = timeseriesStorage({
      getHistoryBatch: async (input) => {
        requestedProjects.push(input.projectId)
        return []
      },
    })
    let readerReads = 0
    let storageReads = 0
    const options = Object.defineProperties(
      {},
      {
        objectReader: {
          enumerable: true,
          get: () => {
            readerReads += 1
            return readerReads === 1 ? reader : foreignReader
          },
        },
        storage: {
          enumerable: true,
          get: () => {
            storageReads += 1
            return storage
          },
        },
      }
    ) as Parameters<typeof getTelemetryHistoryBatch>[1]
    const reads = new Map<string, number>()
    const read = <T>(field: string, value: T): T => {
      reads.set(field, (reads.get(field) ?? 0) + 1)
      return value
    }
    const authoredSeries = Object.defineProperties(
      {},
      {
        objectTypeId: { enumerable: true, get: () => read("objectTypeId", Sensor.id) },
        objectId: { enumerable: true, get: () => read("objectId", "sensor-1") },
        propertyId: { enumerable: true, get: () => read("propertyId", "temperature") },
      }
    ) as TimeseriesHistorySeriesInput
    const series = new Proxy([authoredSeries], {
      get: (target, property, receiver) => {
        if (property === "length") read("length", undefined)
        if (property === "0") read("series[0]", undefined)
        return Reflect.get(target, property, receiver)
      },
    })
    const input = Object.defineProperties(
      {},
      {
        series: { enumerable: true, get: () => read("series", series) },
        from: { enumerable: true, get: () => read("from", undefined) },
        to: { enumerable: true, get: () => read("to", undefined) },
        limitPerSeries: { enumerable: true, get: () => read("limitPerSeries", 1) },
        order: { enumerable: true, get: () => read("order", "asc" as const) },
        projectId: {
          enumerable: true,
          get: () => {
            throw new Error("forged projectId must not be read")
          },
        },
      }
    ) as unknown as Parameters<typeof getTelemetryHistoryBatch>[0]

    await expect(getTelemetryHistoryBatch(input, options)).resolves.toEqual([
      { ...sensorSeries("sensor-1", "temperature"), points: [] },
    ])
    expect(readerReads).toBe(1)
    expect(storageReads).toBe(1)
    expect(Object.fromEntries(reads)).toEqual({
      series: 1,
      from: 1,
      to: 1,
      limitPerSeries: 1,
      order: 1,
      length: 1,
      "series[0]": 1,
      objectTypeId: 1,
      objectId: 1,
      propertyId: 1,
    })
    expect(requestedProjects).toEqual([projectId])
  })

  test("applies the delegated JSON release budget to history and latest", async () => {
    const reader = createAuthorizedObjectReader({
      scope: delegatedScope({
        roots: [selectedRoot("sensor-1", ["id", "temperature"])],
        maxOutputJsonBytes: 32,
      }),
      ontology,
      objectStorage: seededObjectStorage(["sensor-1"]),
    })
    const series = sensorSeries("sensor-1", "temperature")
    const storage = timeseriesStorage({
      getHistoryBatch: async () => [{ ...series, points: [point(series)] }],
      getLatest: async () => point(series),
    })

    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage, objectReader: reader }
      )
    ).rejects.toMatchObject({
      code: "object_read_limit_exceeded",
      metric: "outputJsonBytes",
      limit: 32,
    })
    await expect(
      getLatestTelemetryPoint(series, { storage, objectReader: reader })
    ).rejects.toMatchObject({
      code: "object_read_limit_exceeded",
      metric: "outputJsonBytes",
      limit: 32,
    })
  })
})

function principalScope(): ExecutionScope {
  return createPrincipalRequestScope({
    projectId,
    requestId: "telemetry-principal",
    correlationId: "telemetry-principal-correlation",
    context: {
      principal: { type: "user", id: "telemetry-user" },
      groupIds: [],
      roleIds: [],
      grants: {
        ...emptyGrantIndex(),
        "view:object": new Set([Sensor.id]),
      },
    },
  })
}

function delegatedScope(input: {
  readonly roots: Parameters<
    typeof createDelegatedRequestScope
  >[0]["objectRead"]["selection"]["roots"]
  readonly maxOutputJsonBytes?: number
}): ExecutionScope {
  return createDelegatedRequestScope({
    projectId,
    requestId: "telemetry-delegated",
    correlationId: "telemetry-delegated-correlation",
    objectRead: {
      selection: { kind: "selected", roots: input.roots },
      limits: {
        maxTraversalFacts: 100,
        maxOutputJsonBytes: input.maxOutputJsonBytes ?? 100_000,
      },
    },
  })
}

function selectedRoot(primaryId: string, propertyIds: readonly string[]) {
  return {
    anchor: { objectTypeId: Sensor.id, primaryId },
    node: {
      objects: [{ objectTypeId: Sensor.id, propertyIds }],
      links: [],
    },
  }
}

function seededObjectStorage(primaryIds: readonly string[]): InMemoryObjectStorage {
  const storage = new InMemoryObjectStorage()
  const adapter = getInMemoryObjectMaterializerAdapter(storage)
  for (const primaryId of primaryIds) {
    adapter.applyExactObject(
      {
        ref: { objectTypeId: Sensor.id, primaryId },
        properties: { id: primaryId },
        version: 1,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        lastCommitId: `commit:${primaryId}`,
      },
      projectId
    )
  }
  return storage
}

function selectedStorageFactory(reader: ObjectReadStorage): ObjectStorage {
  return { createSelectedReadScope: () => reader } as unknown as ObjectStorage
}

function sensorSeries(
  objectId: string,
  propertyId: "temperature" | "humidity"
): TimeseriesHistorySeriesInput {
  return { objectTypeId: Sensor.id, objectId, propertyId }
}

function point(series: TimeseriesHistorySeriesInput): TimeseriesPoint {
  return {
    projectId,
    ...series,
    value: 21,
    at,
    lastCommitId: `commit:${series.objectId}:${series.propertyId}`,
  }
}

function timeseriesStorage(overrides: Partial<TimeseriesStorage> = {}): TimeseriesStorage {
  return {
    getHistory: async () => [],
    getHistoryBatch: async () => [],
    getLatest: async () => null,
    ...overrides,
  }
}
