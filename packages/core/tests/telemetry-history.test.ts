import { describe, expect, test } from "bun:test"
import type { RuntimeAccessPlan } from "../src/authorization"
import { createAuthorizedObjectReader } from "../src/execution/authorized-object-reader"
import { DEFAULT_DELEGATED_EXECUTION_LIMITS } from "../src/execution/limits"
import { createDelegatedRequestScope, createTestingScope } from "../src/execution/scopes"
import { getLatestTelemetryPoint, getTelemetryHistoryBatch } from "../src/objects/telemetry/history"
import { defineObjectType, OntologyRegistry, prop } from "../src/ontology"
import type {
  ObjectReadStorage,
  ObjectStorage,
  TimeseriesHistorySeriesInput,
  TimeseriesStorage,
} from "../src/storage"
import {
  getInMemoryObjectMaterializerAdapter,
  InMemoryObjectStorage,
} from "../src/storage/objects/in-memory"

const Sensor = defineObjectType({
  id: "Sensor",
  name: "Sensor",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("temperature", "double", { mode: "telemetry" }),
  ],
})
const ontology = new OntologyRegistry({ sources: [Sensor] })

describe("telemetry history", () => {
  test("derives the history project from the nominal reader", async () => {
    const projectId = "telemetry-history-project"
    const scope = createTestingScope({
      projectId,
      executionId: "execution-1",
      correlationId: "correlation-1",
    })
    let historyCalls = 0
    const requestedProjects: string[] = []
    const storage = {
      getHistory: async () => [],
      getLatest: async () => null,
      getHistoryBatch: async (input) => {
        historyCalls += 1
        requestedProjects.push(input.projectId)
        return []
      },
    } satisfies TimeseriesStorage
    const objectStorage = new InMemoryObjectStorage()
    getInMemoryObjectMaterializerAdapter(objectStorage).applyExactObject(
      {
        ref: { objectTypeId: Sensor.id, primaryId: "sensor-1" },
        properties: { id: "sensor-1" },
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastCommitId: "commit-1",
      },
      projectId
    )
    const objectReader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage,
    })

    await expect(
      getTelemetryHistoryBatch(
        {
          projectId: "other-project",
          series: [{ objectTypeId: Sensor.id, objectId: "sensor-1", propertyId: "temperature" }],
        } as Parameters<typeof getTelemetryHistoryBatch>[0],
        { storage, objectReader }
      )
    ).resolves.toEqual([
      {
        objectTypeId: Sensor.id,
        objectId: "sensor-1",
        propertyId: "temperature",
        points: [],
      },
    ])
    expect(historyCalls).toBe(1)
    expect(requestedProjects).toEqual([projectId])
  })

  test("checks unique series in one aligned reader batch and remaps duplicate results", async () => {
    const projectId = "telemetry-history-project"
    const access: RuntimeAccessPlan = {
      grants: [
        {
          kind: "object.view",
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: "Sensor", primaryId: "sensor-1" },
                node: {
                  objects: [{ objectTypeId: "Sensor", propertyIds: ["temperature"] }],
                  links: [],
                },
              },
            ],
          },
        },
      ],
    }
    const scope = createDelegatedRequestScope({
      projectId,
      requestId: "request-1",
      correlationId: "correlation-1",
      access,
      delegation: { kind: "share", id: "share-1" },
    })

    const baseReader = new InMemoryObjectStorage().createReadScope({
      projectId,
      scope: { kind: "all" },
      limits: DEFAULT_DELEGATED_EXECUTION_LIMITS,
    })
    let selectionCalls = 0
    const requestedItemBatches: (readonly {
      objectTypeId: string
      primaryId: string
      propertyId: string
    }[])[] = []
    const testReader = {
      ...baseReader,
      selectsObjectProperties: async (input) => {
        selectionCalls += 1
        requestedItemBatches.push(input.items)
        return input.items.map((item) => item.primaryId === "sensor-1")
      },
    } satisfies ObjectReadStorage
    const objectReader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: storageFactory(testReader),
    })

    let historyCalls = 0
    let requestedSeries: readonly TimeseriesHistorySeriesInput[] = []
    const timeseries: TimeseriesStorage = {
      getHistory: async () => [],
      getLatest: async () => null,
      getHistoryBatch: async (input) => {
        historyCalls += 1
        requestedSeries = input.series
        return input.series.map((series) => ({
          ...series,
          points: [
            {
              projectId,
              objectTypeId: series.objectTypeId,
              objectId: series.objectId,
              propertyId: series.propertyId,
              value: 21,
              at: new Date("2026-01-01T00:00:00.000Z"),
              lastCommitId: "commit-1",
            },
          ],
        }))
      },
    }
    const visible = {
      objectTypeId: "Sensor",
      objectId: "sensor-1",
      propertyId: "temperature",
    }
    const hidden = {
      objectTypeId: "Sensor",
      objectId: "sensor-2",
      propertyId: "temperature",
    }

    await expect(
      getTelemetryHistoryBatch(
        { series: [visible] },
        {
          storage: timeseries,
          objectReader,
        }
      )
    ).rejects.toThrow("requires an explicit non-negative safe integer limit")
    await expect(
      getTelemetryHistoryBatch(
        { series: Array.from({ length: 101 }, () => visible), limitPerSeries: 1 },
        {
          storage: timeseries,
          objectReader,
        }
      )
    ).rejects.toMatchObject({ metric: "telemetrySeries", limit: 100 })
    const oversizedSparseSeries = new Array<TimeseriesHistorySeriesInput>(101)
    await expect(
      getTelemetryHistoryBatch(
        { series: oversizedSparseSeries, limitPerSeries: 1 },
        {
          storage: timeseries,
          objectReader,
        }
      )
    ).rejects.toMatchObject({ metric: "telemetrySeries", limit: 100 })
    await expect(
      getTelemetryHistoryBatch(
        { series: [visible], limitPerSeries: 10_001 },
        {
          storage: timeseries,
          objectReader,
        }
      )
    ).rejects.toMatchObject({ metric: "telemetryPoints", limit: 10_000 })
    expect(selectionCalls).toBe(0)
    expect(historyCalls).toBe(0)

    const results = await getTelemetryHistoryBatch(
      { series: [visible, visible, hidden], limitPerSeries: 1 },
      {
        storage: timeseries,
        objectReader,
      }
    )

    expect(selectionCalls).toBe(2)
    expect(requestedItemBatches).toEqual([
      [
        { objectTypeId: "Sensor", primaryId: "sensor-1", propertyId: "temperature" },
        { objectTypeId: "Sensor", primaryId: "sensor-2", propertyId: "temperature" },
      ],
      [{ objectTypeId: "Sensor", primaryId: "sensor-1", propertyId: "temperature" }],
    ])
    expect(historyCalls).toBe(1)
    expect(requestedSeries).toEqual([visible])
    expect(results.map((result) => result.points.length)).toEqual([1, 1, 0])

    const tinyScope = createDelegatedRequestScope({
      projectId,
      requestId: "request-tiny-output",
      correlationId: "correlation-tiny-output",
      access,
      limits: {
        ...DEFAULT_DELEGATED_EXECUTION_LIMITS,
        maxVisibleJsonBytes: 8,
      },
      delegation: { kind: "share", id: "share-tiny-output" },
    })
    const tinyObjectReader = createAuthorizedObjectReader({
      scope: tinyScope,
      ontology,
      objectStorage: storageFactory(testReader),
    })
    await expect(
      getTelemetryHistoryBatch(
        { series: [visible], limitPerSeries: 1 },
        {
          storage: timeseries,
          objectReader: tinyObjectReader,
        }
      )
    ).rejects.toMatchObject({
      code: "delegated_execution_limit_exceeded",
      metric: "visibleJsonBytes",
      limit: 8,
    })
  })

  test("revalidates live visibility after history and latest fetches", async () => {
    const projectId = "telemetry-live-revocation"
    const scope = createDelegatedRequestScope({
      projectId,
      requestId: "request-live-revocation",
      correlationId: "correlation-live-revocation",
      access: {
        grants: [
          {
            kind: "object.view",
            selection: {
              kind: "selected",
              roots: [
                {
                  anchor: { objectTypeId: Sensor.id, primaryId: "sensor-1" },
                  node: {
                    objects: [{ objectTypeId: Sensor.id, propertyIds: ["id", "temperature"] }],
                    links: [],
                  },
                },
              ],
            },
          },
        ],
      },
      delegation: { kind: "share", id: "share-live-revocation" },
    })
    const baseReader = new InMemoryObjectStorage().createReadScope({
      projectId,
      scope: { kind: "all" },
      limits: DEFAULT_DELEGATED_EXECUTION_LIMITS,
    })
    let visibilityChecks = 0
    const testReader: ObjectReadStorage = {
      ...baseReader,
      selectsObjectProperties: async (input) => {
        visibilityChecks += 1
        return input.items.map(() => visibilityChecks === 1)
      },
    }
    const objectReader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: storageFactory(testReader),
    })
    const series = {
      objectTypeId: Sensor.id,
      objectId: "sensor-1",
      propertyId: "temperature",
    }
    const point = {
      projectId,
      ...series,
      value: 21,
      at: new Date("2026-01-01T00:00:00.000Z"),
      lastCommitId: "commit-live-revocation",
    }
    let historyCalls = 0
    let latestCalls = 0
    const timeseries: TimeseriesStorage = {
      getHistory: async () => [],
      getHistoryBatch: async () => {
        historyCalls += 1
        return [{ ...series, points: [point] }]
      },
      getLatest: async () => {
        latestCalls += 1
        return point
      },
    }

    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage: timeseries, objectReader }
      )
    ).resolves.toEqual([{ ...series, points: [] }])
    expect(visibilityChecks).toBe(2)
    expect(historyCalls).toBe(1)

    visibilityChecks = 0
    await expect(
      getLatestTelemetryPoint(series, { storage: timeseries, objectReader })
    ).resolves.toBeNull()
    expect(visibilityChecks).toBe(2)
    expect(latestCalls).toBe(1)
  })

  test("rejects an unauthorized telemetry property before timeseries storage", async () => {
    const projectId = "telemetry-history-project"
    const scope = createDelegatedRequestScope({
      projectId,
      requestId: "request-raw-reader",
      correlationId: "correlation-raw-reader",
      access: { grants: [] },
      delegation: { kind: "share", id: "share-raw-reader" },
    })
    let readerCalls = 0
    let historyCalls = 0
    const baseStorage = new InMemoryObjectStorage()
    const testReader: ObjectReadStorage = {
      ...baseStorage.createReadScope({
        projectId,
        scope: { kind: "all" },
        limits: DEFAULT_DELEGATED_EXECUTION_LIMITS,
      }),
      selectsObjectProperties: async () => {
        readerCalls += 1
        return []
      },
    }
    const objectReader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: storageFactory(testReader),
    })
    const timeseries = {
      getHistoryBatch: async () => {
        historyCalls += 1
        return []
      },
    } as unknown as TimeseriesStorage

    await expect(
      getTelemetryHistoryBatch(
        {
          series: [{ objectTypeId: Sensor.id, objectId: "sensor-1", propertyId: "temperature" }],
          limitPerSeries: 1,
        },
        {
          storage: timeseries,
          objectReader,
        }
      )
    ).rejects.toThrow("cannot read property 'Sensor.temperature'")
    expect(readerCalls).toBe(0)
    expect(historyCalls).toBe(0)
  })

  test("rejects provider points outside the requested series and per-series limit", async () => {
    const projectId = "telemetry-provider-contract"
    const scope = createTestingScope({
      projectId,
      executionId: "execution-provider-contract",
      correlationId: "correlation-provider-contract",
    })
    const objectReader = createAuthorizedObjectReader({
      scope,
      ontology,
      objectStorage: new InMemoryObjectStorage(),
    })
    const series = {
      objectTypeId: Sensor.id,
      objectId: "sensor-1",
      propertyId: "temperature",
    }
    const point = {
      projectId,
      ...series,
      value: 21,
      at: new Date("2026-01-01T00:00:00.000Z"),
      lastCommitId: "commit-provider-contract",
    }

    const mismatchedPointStorage = {
      getHistoryBatch: async () => [
        {
          ...series,
          points: [{ ...point, propertyId: "hidden-property" }],
        },
      ],
    } as unknown as TimeseriesStorage
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 1 },
        { storage: mismatchedPointStorage, objectReader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })

    const overLimitStorage = {
      getHistoryBatch: async () => [{ ...series, points: [point] }],
    } as unknown as TimeseriesStorage
    await expect(
      getTelemetryHistoryBatch(
        { series: [series], limitPerSeries: 0 },
        { storage: overLimitStorage, objectReader }
      )
    ).rejects.toMatchObject({ code: "internal.unexpected" })
  })
})

function storageFactory(reader: ObjectReadStorage): ObjectStorage {
  return { createReadScope: () => reader } as unknown as ObjectStorage
}
