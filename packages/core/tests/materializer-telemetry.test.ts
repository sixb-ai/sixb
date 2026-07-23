import { describe, expect, test } from "bun:test"
import { InMemoryStorage, InMemoryTimeseriesStorage } from "../src"
import type { StoredTelemetryAppendedEvent } from "../src/events"
import type { Storage, StorageTransactionOptions } from "../src/storage"
import { getInMemoryOntologyStorageTestingAdapter } from "../src/storage/ontology/in-memory/testing"
import { decorateOperationScopedMethodForTesting } from "../src/storage/operation-scope"
import {
  claimProjectionExecution,
  createMaterializerFixture,
  pendingProjectionExecution,
  replacement,
  sourceEntry,
} from "./materializer-fixture"

const series = {
  object: { objectTypeId: "Device", primaryId: "one" },
  propertyId: "temperature",
}

describe("ontology materializer telemetry", () => {
  test("correlates durable targets for telemetry batches and terminal decisions", async () => {
    const { materializer, storage, projections } = createMaterializerFixture()
    const resolved = projections.resolveTelemetry("temperatures")
    const datasetVersion = {
      datasetId: "readings",
      versionId: "wrong-telemetry-target",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const run = await storage.projectionRuns.startOrReclaimMaterialization({
      id: "wrong-telemetry-target-run",
      projectId: "project",
      identity: {
        projectionId: resolved.projectionId,
        projectionKind: "telemetry",
        protocol: "telemetry",
        datasetVersion,
        ontologyRevision: projections.ontologyRevision,
        projectionRevision: resolved.projectionRevision,
        ownershipHash: resolved.ownershipHash,
      },
      objectTypeId: "Secret",
      fixedBatchSize: 1,
    })
    if (!run.executionToken) throw new Error("Projection run was not claimed")
    const execution = { projectionRunId: run.id, executionToken: run.executionToken }

    await expect(
      materializer.telemetry.append({
        source: {
          kind: "projection",
          projection: { projectionId: "temperatures" },
          datasetVersion,
          execution,
          batchOrdinal: 0,
          sourceRowCount: 1,
          inputExhausted: true,
        },
        points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
      })
    ).rejects.toMatchObject({ kind: "run-correlation" })
    await expect(
      materializer.projections.finishRun({
        protocol: "telemetry",
        source: { projectionId: "temperatures" },
        datasetVersion,
        execution,
        status: "failed",
      })
    ).rejects.toMatchObject({ kind: "run-correlation" })
  })

  test("finishes telemetry only after exhaustion or an explicit empty input", async () => {
    const { materializer, storage, projections } = createMaterializerFixture()
    const datasetVersion = {
      datasetId: "readings",
      versionId: "telemetry-finish",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const emptyExecution = await claimProjectionExecution(storage, projections, {
      runId: "telemetry-empty-finish-run",
      projectionId: "temperatures",
      protocol: "telemetry",
      datasetVersion,
      fixedBatchSize: 10,
    })
    const emptyFinish = {
      protocol: "telemetry" as const,
      source: { projectionId: "temperatures" },
      datasetVersion,
      execution: emptyExecution,
      status: "succeeded" as const,
    }

    await expect(materializer.projections.finishRun(emptyFinish)).rejects.toThrow(
      "before its input is exhausted"
    )
    let rejectFinish = true
    decorateOperationScopedMethodForTesting(
      storage.projectionRuns,
      "finishMaterialization",
      (finishMaterialization) => async (input) => {
        if (rejectFinish) throw new Error("projection run finish failure")
        return finishMaterialization(input)
      }
    )
    await expect(
      materializer.projections.finishRun({ ...emptyFinish, emptyInput: true })
    ).rejects.toThrow("projection run finish failure")
    await expect(
      storage.projectionRuns.getById({ projectId: "project", id: emptyExecution.projectionRunId })
    ).resolves.toMatchObject({
      status: "running",
      telemetryCheckpoint: { inputExhausted: false },
    })
    rejectFinish = false
    await expect(
      materializer.projections.finishRun({ ...emptyFinish, emptyInput: true })
    ).resolves.toBeUndefined()
    await expect(
      storage.projectionRuns.getById({ projectId: "project", id: emptyExecution.projectionRunId })
    ).resolves.toMatchObject({
      status: "succeeded",
      telemetryCheckpoint: { nextRowOffset: 0, inputExhausted: true },
    })
    await expect(
      storage.ontology.commits.getByOrigin({
        projectId: "project",
        origin: {
          kind: "telemetry",
          projectionRunId: emptyExecution.projectionRunId,
          batchOrdinal: 0,
        },
      })
    ).resolves.toBeNull()

    await materializer.projections.replace(
      replacement("telemetry-finish-object", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const execution = await claimProjectionExecution(storage, projections, {
      runId: "telemetry-finish-run",
      projectionId: "temperatures",
      protocol: "telemetry",
      datasetVersion,
      fixedBatchSize: 1,
    })
    const source = (batchOrdinal: number, inputExhausted: boolean) => ({
      kind: "projection" as const,
      projection: { projectionId: "temperatures" },
      datasetVersion,
      execution,
      batchOrdinal,
      sourceRowCount: 1,
      inputExhausted,
    })
    await materializer.telemetry.append({
      source: source(0, false),
      points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
    })
    const finish = {
      protocol: "telemetry" as const,
      source: { projectionId: "temperatures" },
      datasetVersion,
      execution,
      status: "succeeded" as const,
    }
    await expect(
      materializer.projections.finishRun({ ...finish, emptyInput: true })
    ).rejects.toThrow("cannot declare empty input after progress")
    await expect(materializer.projections.finishRun(finish)).rejects.toThrow(
      "before its input is exhausted"
    )
    await materializer.telemetry.append({
      source: source(1, true),
      points: [{ series, value: 21, at: "2026-01-01T02:00:00Z" }],
    })
    await expect(materializer.projections.finishRun(finish)).resolves.toBeUndefined()
  })

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
      now: "2027-01-01T00:00:00.000Z",
      limit: 100,
      leaseId: "telemetry-events",
      leaseExpiresAt: "2027-01-01T01:00:00.000Z",
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
    await materializer.projections.replace(
      replacement("telemetry-validation", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
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
    await materializer.projections.replace(
      replacement("telemetry-batches", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const datasetVersion = {
      datasetId: "readings",
      versionId: "readings-v1",
      createdAt: "2026-01-01T00:00:00Z",
    }
    const append = (
      batchOrdinal: number,
      value: number | string,
      runId = "telemetry-run",
      inputExhausted = false
    ) =>
      materializer.telemetry.append({
        source: {
          kind: "projection",
          projection: { projectionId: "temperatures" },
          datasetVersion,
          execution: pendingProjectionExecution(runId),
          batchOrdinal,
          sourceRowCount: 1,
          inputExhausted,
        },
        points: [{ series, value, at: `2026-01-01T0${batchOrdinal + 1}:00:00Z` }],
      })
    let rejectCheckpoint = true
    decorateOperationScopedMethodForTesting(
      storage.projectionRuns,
      "advanceTelemetryCheckpoint",
      (advanceCheckpoint) => async (checkpoint) => {
        const advanced = await advanceCheckpoint(checkpoint)
        if (rejectCheckpoint) throw new Error("telemetry checkpoint failure")
        return advanced
      }
    )
    await expect(append(0, 20, "telemetry-failed-run")).rejects.toThrow(
      "telemetry checkpoint failure"
    )
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-failed-run" })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 0, nextRowOffset: 0, inputExhausted: false },
    })
    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toEqual([])

    rejectCheckpoint = false
    await append(0, 20)
    expect((await append(0, 20)).created).toBe(false)
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-run" })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 1, nextRowOffset: 1, inputExhausted: false },
    })
    await expect(append(1, "bad")).rejects.toThrow("must be numeric")
    const second = await append(1, 21, "telemetry-run", true)
    expect(second.created).toBe(true)
    expect(
      await storage.projectionRuns.getById({ projectId: "project", id: "telemetry-run" })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 2, nextRowOffset: 2, inputExhausted: true },
    })
    const ledger = await storage.ontology.commits.list({
      projectId: "project",
      run: { kind: "projection", id: "telemetry-run" },
    })
    expect(ledger.commits.map((commit) => commit.origin)).toMatchObject([
      { source: { batchOrdinal: 0 } },
      { source: { batchOrdinal: 1 } },
    ])
    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toHaveLength(2)
  })

  test("uses one fenced transaction per projection batch and keeps runtime replay cheap", async () => {
    class TransactionCountingStorage extends InMemoryStorage {
      transactions: (StorageTransactionOptions | undefined)[] = []

      override async transaction<T>(
        run: (tx: Storage) => Promise<T> | T,
        options?: StorageTransactionOptions
      ): Promise<T> {
        this.transactions.push(options)
        return super.transaction(run, options)
      }
    }

    const storage = new TransactionCountingStorage()
    const { materializer, projections } = createMaterializerFixture({ storage })
    await materializer.projections.replace(
      replacement("telemetry-one-transaction", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const datasetVersion = {
      datasetId: "readings",
      versionId: "one-transaction-v1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }
    const execution = await claimProjectionExecution(storage, projections, {
      runId: "telemetry-one-transaction-run",
      projectionId: "temperatures",
      protocol: "telemetry",
      datasetVersion,
      fixedBatchSize: 1,
    })
    const projectionAppend = {
      source: {
        kind: "projection" as const,
        projection: { projectionId: "temperatures" },
        datasetVersion,
        execution,
        batchOrdinal: 0,
        sourceRowCount: 1,
        inputExhausted: true,
      },
      points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
    }

    storage.transactions = []
    await expect(materializer.telemetry.append(projectionAppend)).resolves.toMatchObject({
      created: true,
    })
    expect(storage.transactions).toEqual([{ isolation: "serializable" }])

    storage.transactions = []
    await expect(materializer.telemetry.append(projectionAppend)).resolves.toMatchObject({
      created: false,
    })
    expect(storage.transactions).toEqual([{ isolation: "serializable" }])

    const runtimeAppend = {
      source: { kind: "runtime" as const, requestId: "runtime-cheap-replay" },
      points: [{ series, value: 21, at: "2026-01-01T02:00:00Z" }],
    }
    storage.transactions = []
    await expect(materializer.telemetry.append(runtimeAppend)).resolves.toMatchObject({
      created: true,
    })
    expect(storage.transactions).toEqual([{ isolation: "serializable" }])

    storage.transactions = []
    await expect(materializer.telemetry.append(runtimeAppend)).resolves.toMatchObject({
      created: false,
    })
    expect(storage.transactions).toEqual([])
  })

  test("uses physical input size for telemetry batch continuation after equal deduplication", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("telemetry-deduplication", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const source = (batchOrdinal: number) => ({
      kind: "projection" as const,
      projection: { projectionId: "temperatures" },
      datasetVersion: {
        datasetId: "readings",
        versionId: "deduplicated-v1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      execution: pendingProjectionExecution("telemetry-deduplicated-run"),
      batchOrdinal,
      sourceRowCount: 2,
      inputExhausted: batchOrdinal === 1,
    })
    const duplicate = { series, value: 20, at: "2026-01-01T01:00:00Z" }

    await expect(
      materializer.telemetry.append({
        source: source(0),
        points: [duplicate, { ...duplicate }],
      })
    ).resolves.toMatchObject({ pointsCreated: 1 })
    await expect(
      materializer.telemetry.append({
        source: source(1),
        points: [
          { series, value: 21, at: "2026-01-01T02:00:00Z" },
          { series, value: 22, at: "2026-01-01T03:00:00Z" },
        ],
      })
    ).resolves.toMatchObject({ pointsCreated: 2 })

    expect(
      await storage.projectionRuns.getById({
        projectId: "project",
        id: "telemetry-deduplicated-run",
      })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 2, nextRowOffset: 4, inputExhausted: true },
    })
  })

  test("commits an all-skipped source batch so its row checkpoint can advance", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("telemetry-skipped", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    const result = await materializer.telemetry.append({
      source: {
        kind: "projection",
        projection: { projectionId: "temperatures" },
        datasetVersion: {
          datasetId: "readings",
          versionId: "skipped-v1",
          createdAt: "2026-01-01T00:00:00Z",
        },
        execution: pendingProjectionExecution("telemetry-skipped-run"),
        batchOrdinal: 0,
        sourceRowCount: 2,
        inputExhausted: true,
      },
      points: [],
    })

    expect(result).toMatchObject({
      created: true,
      pointsCreated: 0,
      pointsUpdated: 0,
      pointsUnchanged: 0,
    })
    expect(
      await storage.projectionRuns.getById({
        projectId: "project",
        id: "telemetry-skipped-run",
      })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 1, nextRowOffset: 2, inputExhausted: true },
    })
    await expect(
      storage.ontology.commits.list({
        projectId: "project",
        run: { kind: "projection", id: "telemetry-skipped-run" },
      })
    ).resolves.toMatchObject({
      commits: [
        {
          intent: {
            source: { batchOrdinal: 0, sourceRowCount: 2, inputExhausted: true },
          },
        },
      ],
      total: 1,
    })
  })

  test("rejects fabricated telemetry result counts before recording the commit", async () => {
    const { materializer, storage } = createMaterializerFixture()
    await materializer.projections.replace(
      replacement("telemetry-counts", "2026-01-01T00:00:00Z", [sourceEntry("one", "one")])
    )
    decorateOperationScopedMethodForTesting(
      storage.ontology.materializations,
      "finalize",
      (finalize) => (input) => {
        if (input.finalization.result.kind !== "telemetry") return finalize(input)
        return finalize({
          ...input,
          finalization: {
            ...input.finalization,
            result: { ...input.finalization.result, pointsCreated: -1 },
          },
        })
      }
    )

    await expect(
      materializer.telemetry.append({
        source: { kind: "runtime", requestId: "fabricated-telemetry-counts" },
        points: [{ series, value: 20, at: "2026-01-01T00:00:00Z" }],
      })
    ).rejects.toThrow("result counts do not correlate")
  })

  test("rejects an empty projection batch before creating a commit", async () => {
    const { materializer, storage, projections } = createMaterializerFixture()
    const datasetVersion = {
      datasetId: "readings",
      versionId: "empty-v1",
      createdAt: "2026-01-01T00:00:00Z",
    }
    const execution = await claimProjectionExecution(storage, projections, {
      runId: "telemetry-empty-run",
      projectionId: "temperatures",
      protocol: "telemetry",
      datasetVersion,
      fixedBatchSize: 10,
    })
    const ontologyActivity: string[] = []
    getInMemoryOntologyStorageTestingAdapter(storage.ontology).setTestHooks({
      beforeRead(boundary) {
        ontologyActivity.push(`read:${boundary}`)
      },
      beforeWrite(boundary) {
        ontologyActivity.push(`write:${boundary}`)
      },
    })

    await expect(
      materializer.telemetry.append({
        source: {
          kind: "projection",
          projection: { projectionId: "temperatures" },
          datasetVersion,
          execution,
          batchOrdinal: 0,
          sourceRowCount: 0,
          inputExhausted: true,
        },
        points: [],
      })
    ).rejects.toThrow("empty dataset produces no batch commit")

    expect(ontologyActivity).toEqual([])
    expect(
      await storage.projectionRuns.getById({
        projectId: "project",
        id: execution.projectionRunId,
      })
    ).toMatchObject({
      telemetryCheckpoint: { nextBatchOrdinal: 0, nextRowOffset: 0, inputExhausted: false },
    })
  })

  test("rejects telemetry for an absent effective object without persisting anything", async () => {
    const { materializer, storage } = createMaterializerFixture()

    await expect(
      materializer.telemetry.append({
        source: { kind: "runtime", requestId: "missing-object" },
        points: [{ series, value: 20, at: "2026-01-01T01:00:00Z" }],
      })
    ).rejects.toThrow("Cannot append telemetry to missing object 'Device:one'")

    expect(
      await storage.timeseries.getHistory({
        projectId: "project",
        objectTypeId: "Device",
        objectId: "one",
        propertyId: "temperature",
      })
    ).toEqual([])
    expect(
      await storage.ontology.commits.getByIdempotencyKey({
        projectId: "project",
        idempotencyKey: "runtime:missing-object",
      })
    ).toBeNull()
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
