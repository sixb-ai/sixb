import { describe, expect, test } from "bun:test"
import { InMemoryTimeseriesStorage } from "../src"
import type { StoredTelemetryAppendedEvent } from "../src/events"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { createMaterializerFixture, replacement, sourceEntry } from "./materializer-fixture"

const series = {
  object: { objectTypeId: "Device", primaryId: "one" },
  propertyId: "temperature",
}

describe("ontology materializer telemetry", () => {
  test("classifies a large point batch once while bounding provider pages and plan chunks", async () => {
    let maxCoreExistingPoints = 0
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: { statePageRows: 3, planChunkRows: 5, planChunkBytes: 1_000_000 },
        observeCoreBuffer(boundary, rows) {
          if (boundary === "telemetry.existing-points") {
            maxCoreExistingPoints = Math.max(maxCoreExistingPoints, rows)
          }
        },
      },
    })
    await materializer.projections.replace(
      replacement("telemetry-scale", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const classifications: string[] = []
    const buffers = new Map<string, number>()
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      observeWork(records) {
        for (const record of records) {
          if (record.kind === "classification" && record.entityKind === "point") {
            classifications.push(record.recordKey)
          }
        }
      },
      observeBuffer(boundary, rows) {
        buffers.set(boundary, Math.max(buffers.get(boundary) ?? 0, rows))
      },
    })
    const points = Array.from({ length: 400 }, (_, index) => ({
      series,
      value: index,
      at: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
    }))
    const result = await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "telemetry-scale" },
      points,
    })
    expect(result.pointsCreated).toBe(400)
    expect(classifications).toHaveLength(400)
    expect(new Set(classifications).size).toBe(400)
    expect(buffers.get("state.point.page")).toBeLessThanOrEqual(3)
    expect(buffers.get("work.apply.page")).toBeLessThanOrEqual(5)
    expect(buffers.get("work.event.page")).toBeLessThanOrEqual(5)
    expect(buffers.get("work.stage")).toBeLessThanOrEqual(5)
    expect(buffers.get("apply.chunk")).toBeLessThanOrEqual(5)
    expect(maxCoreExistingPoints).toBeLessThanOrEqual(3)
  })

  test("classifies canonical point create/update/no-op and only derives the latest value", async () => {
    const { materializer, storage } = createMaterializerFixture({
      dependencies: {
        batching: { statePageRows: 1, planChunkRows: 1, planChunkBytes: 1 },
      },
    })
    await materializer.projections.replace(
      replacement("v1", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )

    const created = await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "point-create" },
      points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
    })
    expect(created).toMatchObject({
      pointsCreated: 1,
      pointsUpdated: 0,
      pointsUnchanged: 0,
      latestObjectsChanged: 1,
      eventCount: 2,
    })
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.temperature
    ).toBe(20)

    const updated = await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "point-update" },
      points: [{ series, value: 21, at: "2026-01-01T01:00:00Z" }],
    })
    expect(updated).toMatchObject({ pointsUpdated: 1, latestObjectsChanged: 1 })

    const older = await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "older" },
      points: [{ series, value: 10, at: "2025-12-31T01:00:00Z" }],
    })
    expect(older).toMatchObject({ pointsCreated: 1, latestObjectsChanged: 0, eventCount: 1 })
    expect(
      (
        await storage.objects.getByPrimaryId({
          projectId: "project",
          objectTypeId: "Device",
          primaryId: "one",
        })
      )?.properties.temperature
    ).toBe(21)

    const unchanged = await materializer.telemetry.append({
      source: { kind: "runtime", requestId: "point-noop" },
      points: [{ series, value: 21, at: "2026-01-01T01:00:00Z" }],
    })
    expect(unchanged).toMatchObject({
      pointsCreated: 0,
      pointsUpdated: 0,
      pointsUnchanged: 1,
      latestObjectsChanged: 0,
      eventCount: 0,
    })
    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toHaveLength(2)
    const events = await storage.ontology.outbox.claim({
      projectId: "project",
      now: "2027-01-01T00:00:00Z",
      limit: 100,
      leaseId: "telemetry-events",
      leaseExpiresAt: "2027-01-01T01:00:00Z",
    })
    expect(
      events
        .map((row) => row.envelope)
        .filter((event) => event.type === "telemetry.appended")
        .map((event) => event.partitionKey)
    ).toEqual(["Device:one:temperature", "Device:one:temperature", "Device:one:temperature"])
  })

  test("validates telemetry property JSON/type/unit and replays idempotently", async () => {
    const { materializer } = createMaterializerFixture()
    const input = {
      source: { kind: "runtime" as const, requestId: "replay" },
      points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
    }
    const first = await materializer.telemetry.append(input)
    const replay = await materializer.telemetry.append(input)
    expect(first.created).toBe(true)
    expect(replay.created).toBe(false)

    await expect(
      materializer.telemetry.append({
        source: { kind: "runtime", requestId: "static" },
        points: [
          {
            series: { ...series, propertyId: "name" },
            value: "bad",
            at: "2026-01-01T01:00:00Z",
          },
        ],
      })
    ).rejects.toThrow("not telemetry-enabled")
    await expect(
      materializer.telemetry.append({
        source: { kind: "runtime", requestId: "wrong-type" },
        points: [{ series, value: "hot", at: "2026-01-01T01:00:00Z" }],
      })
    ).rejects.toThrow("must be numeric")
    await expect(
      materializer.telemetry.append({
        source: { kind: "runtime", requestId: "unit" },
        points: [{ series, value: 20, unit: "C", at: "2026-01-01T01:00:00Z" }],
      })
    ).rejects.toThrow("cannot accept a unit")
  })

  test("keeps projection telemetry batches as independent commits", async () => {
    const { materializer, storage } = createMaterializerFixture()
    const datasetVersion = {
      datasetId: "readings",
      versionId: "readings-v1",
      createdAt: "2026-01-01T00:00:00Z",
    }
    const startRun = (id: string) =>
      storage.projectionRuns.start({
        id,
        projectId: "project",
        projectionId: "temperatures",
        projectionKind: "telemetry",
        datasetId: "readings",
        datasetVersionId: "readings-v1",
        objectTypeId: "Device",
      })
    const append = (batchOrdinal: number, value: number | string, runId = "telemetry-run") =>
      materializer.telemetry.append({
        source: {
          kind: "projection",
          projection: { projectionId: "temperatures" },
          datasetVersion,
          projectionRunId: runId,
          batchOrdinal,
        },
        points: [{ series, value, at: `2026-01-01T0${batchOrdinal + 1}:00:00Z` }],
      })
    await startRun("telemetry-failed-run")
    let rejectBookkeeping = true
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      applyBookkeeping(_projectId, bookkeeping) {
        if (bookkeeping.kind === "projection" && rejectBookkeeping) {
          throw new Error("telemetry bookkeeping failure")
        }
      },
    })
    await expect(append(0, 20, "telemetry-failed-run")).rejects.toThrow(
      "telemetry bookkeeping failure"
    )
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-failed-run" })
    ).not.toHaveProperty("commitId")
    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toEqual([])

    rejectBookkeeping = false
    await startRun("telemetry-run")
    const committed = await append(0, 20)
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-run" })
    ).toHaveProperty("commitId", committed.commitId)
    await startRun("telemetry-replay-run")
    expect((await append(0, 20, "telemetry-replay-run")).created).toBe(false)
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-replay-run" })
    ).toHaveProperty("commitId", committed.commitId)
    await expect(append(1, "bad")).rejects.toThrow("must be numeric")
    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toHaveLength(1)
  })

  test("uses collision-free canonical series keys and clones returned point values", async () => {
    const storage = new InMemoryTimeseriesStorage()
    const event = (
      id: string,
      projectId: string,
      objectTypeId: string,
      value: unknown
    ): StoredTelemetryAppendedEvent => ({
      id,
      schemaVersion: 1,
      projectId,
      type: "telemetry.appended",
      topic: "telemetry",
      partitionKey: `${objectTypeId}:c:d`,
      occurredAt: "2026-01-01T00:00:00.000Z",
      cursor: id,
      payload: {
        objectTypeId,
        objectId: "c",
        propertyId: "d",
        value,
        at: "2026-01-01T00:00:00.000Z",
      },
    })
    await storage.applyTelemetryAppended(event("one", "p:a", "b", { nested: 1 }))
    await storage.applyTelemetryAppended(event("two", "p", "a:b", { nested: 2 }))

    const first = await storage.getHistory({
      projectId: "p:a",
      objectTypeId: "b",
      objectId: "c",
      propertyId: "d",
    })
    const second = await storage.getHistory({
      projectId: "p",
      objectTypeId: "a:b",
      objectId: "c",
      propertyId: "d",
    })
    expect(first[0].value).toEqual({ nested: 1 })
    expect(second[0].value).toEqual({ nested: 2 })
    ;(first[0].value as { nested: number }).nested = 99
    expect(
      (
        await storage.getLatest({
          projectId: "p:a",
          objectTypeId: "b",
          objectId: "c",
          propertyId: "d",
        })
      )?.value
    ).toEqual({ nested: 1 })
  })
})
