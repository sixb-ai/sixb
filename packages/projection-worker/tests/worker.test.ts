import { describe, expect, test } from "bun:test"
import {
  col,
  type DatasetDefinition,
  type DatasetRow,
  defineDataset,
  defineObjectType,
  defineProjection,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  type LakeStorage,
  type ProjectionDefinition,
  type ProjectionRunStorage,
  prop,
  Sixb,
} from "@sixb/core"
import { ProjectionWorker } from "../src"

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true }), prop("name", "string")],
})

const roomsDataset = defineDataset("canonical.rooms", {
  schema: [col("room_id", "string"), col("room_name", "string")],
})

const roomProjection = defineProjection("room-proj", Room)
  .fromDataset(roomsDataset)
  .properties({ id: "room_id", name: "room_name" })

function createDeps() {
  return {
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
  }
}

function createSixb(options: {
  datasets?: readonly DatasetDefinition[]
  projections?: readonly ProjectionDefinition[]
}) {
  const deps = createDeps()
  return new Sixb({
    id: "projection-worker-tests",
    ontology: [Room],
    ...deps,
    datasets: options.datasets ?? [],
    projections: options.projections ?? [],
  })
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

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn()
    if (predicate(value)) {
      return value
    }
    await Bun.sleep(20)
  }

  throw new Error("Timed out waiting for condition.")
}

describe("ProjectionWorker", () => {
  test("processes queued projection jobs end-to-end", async () => {
    const sixb = createSixb({
      datasets: [roomsDataset],
      projections: [roomProjection],
    })
    const version = await commitDatasetVersion(sixb.lakeStorage, roomsDataset, [
      { room_id: "r1", room_name: "Kitchen" },
    ])
    const [queued] = await sixb.queues.projections.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "projection.run.requested",
          payload: {
            projectionId: "room-proj",
            projectionKind: "object",
            datasetId: "canonical.rooms",
            versionId: version.versionId,
          },
        },
      ],
    })

    const worker = new ProjectionWorker(sixb)
    await worker.start()

    try {
      const runId = `${queued!.id}:attempt:1`
      const projectionRunsStorage = requireProjectionRunsStorage(sixb)
      const run = await waitFor(
        () => projectionRunsStorage.getById({ projectId: sixb.id, id: runId }),
        (value) => value?.status === "succeeded"
      )
      expect(run?.objectsUpserted).toBe(1)

      const room = await sixb.storage.objects.getByPrimaryId({
        projectId: sixb.id,
        objectTypeId: "Room",
        primaryId: "r1",
      })
      expect(room?.properties.name).toBe("Kitchen")

      const claimed = await sixb.queues.projections.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  test("fails the queue job and run when execution fails", async () => {
    const sixb = createSixb({
      datasets: [roomsDataset],
      projections: [roomProjection],
    })
    await sixb.lakeStorage.createDataset(roomsDataset)
    const [queued] = await sixb.queues.projections.enqueue({
      projectId: sixb.id,
      jobs: [
        {
          type: "projection.run.requested",
          payload: {
            projectionId: "room-proj",
            projectionKind: "object",
            datasetId: "canonical.rooms",
            versionId: "missing-version",
          },
        },
      ],
    })

    const worker = new ProjectionWorker(sixb)
    await worker.start()

    try {
      const runId = `${queued!.id}:attempt:1`
      const projectionRunsStorage = requireProjectionRunsStorage(sixb)
      const run = await waitFor(
        () => projectionRunsStorage.getById({ projectId: sixb.id, id: runId }),
        (value) => value?.status === "failed"
      )
      expect(run?.errorMessage).toContain("was not found")

      const claimed = await sixb.queues.projections.claim({
        projectId: sixb.id,
        workerId: "observer",
      })
      expect(claimed).toHaveLength(0)
    } finally {
      await worker.stop()
    }
  })

  test("requires registered projections and projection run storage", () => {
    expect(() => new ProjectionWorker(createSixb({ datasets: [roomsDataset] }))).toThrow(
      "No projection definitions"
    )

    const sixb = createSixb({
      datasets: [roomsDataset],
      projections: [roomProjection],
    })
    const withoutProjectionRuns = {
      id: sixb.id,
      projectId: sixb.projectId,
      ontology: sixb.ontology,
      actionRegistry: sixb.actionRegistry,
      events: sixb.events,
      storage: {
        ...sixb.storage,
        projectionRuns: undefined,
      },
      lakeStorage: sixb.lakeStorage,
      blobStorage: sixb.blobStorage,
      queues: sixb.queues,
      getObjectProjections: () => sixb.getObjectProjections(),
      getLinkProjections: () => sixb.getLinkProjections(),
      getTelemetryProjections: () => sixb.getTelemetryProjections(),
      getDatasetById: (datasetId: string) => sixb.getDatasetById(datasetId),
      getProjectionById: (projectionId: string) => sixb.getProjectionById(projectionId),
    }

    expect(() => new ProjectionWorker(withoutProjectionRuns)).toThrow("storage.projectionRuns")
  })
})
