import { expect, test } from "bun:test"
import {
  getInMemoryTimeseriesMaterializerAdapter,
  InMemoryTimeseriesStorage,
} from "../src/storage/timeseries/store"

test("InMemoryTimeseriesStorage reads one coherent snapshot per history batch", async () => {
  const storage = new InMemoryTimeseriesStorage()
  const materializer = getInMemoryTimeseriesMaterializerAdapter(storage)
  const addPoint = (objectId: string, value: number, at: string) => {
    materializer.applyExactPoint("project", {
      series: {
        object: { objectTypeId: "Device", primaryId: objectId },
        propertyId: "temperature",
      },
      value,
      at,
      lastCommitId: `commit:${objectId}:${at}`,
    })
  }

  for (const objectId of ["device-1", "device-2", "device-3"]) {
    addPoint(objectId, 20, "2026-01-01T00:00:00.000Z")
  }

  const history = storage.getHistoryBatch({
    projectId: "project",
    series: ["device-1", "device-2", "device-3"].map((objectId) => ({
      objectTypeId: "Device",
      objectId,
      propertyId: "temperature",
    })),
  })
  queueMicrotask(() => addPoint("device-3", 21, "2026-01-02T00:00:00.000Z"))

  const results = await history

  // Replacing the parallel snapshot in `getHistoryBatch` with the old awaited loop makes the
  // microtask land between the second and third series and this expectation fail.
  expect(results.map((result) => result.points.map((point) => point.value))).toEqual([
    [20],
    [20],
    [20],
  ])
  expect(
    (
      await storage.getHistoryBatch({
        projectId: "project",
        series: [{ objectTypeId: "Device", objectId: "device-3", propertyId: "temperature" }],
      })
    )[0]?.points.map((point) => point.value)
  ).toEqual([20, 21])
})
