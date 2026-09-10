import { expect, test } from "bun:test"
import { col, defineDataset } from "../src/datasets"
import {
  LakeConcurrencyError,
  LakeStorageError,
  retryDatasetMergeCommit,
} from "../src/lake-storage"

const dataset = defineDataset("retry", {
  schema: [col("id", "string"), col("revision", "int64")],
  primaryKey: "id",
  sequenceBy: "revision",
})

test("merge retries are bounded and preserve the last concurrency failure", async () => {
  // Regression proof: remove the attempt bound; use a fourth-attempt sentinel to avoid a hung test.
  const failure = new LakeConcurrencyError("stale dataset")
  const rebases: boolean[] = []
  await expect(
    retryDatasetMergeCommit({ dataset }, { retryOnConflict: true }, async (rebase) => {
      rebases.push(rebase)
      if (rebases.length > 3) throw new Error("retry bound exceeded")
      throw failure
    })
  ).rejects.toMatchObject({
    name: "LakeConcurrencyError",
    message: expect.stringContaining("exhausted 3"),
    cause: failure,
  })
  expect(rebases).toEqual([false, true, true])
})

test("merge retries exclude validation, source-content, and ambiguous provider failures", async () => {
  for (const failure of [
    new LakeStorageError("conflicting source content"),
    new Error("validation failed"),
    new Error("connection lost after COMMIT"),
  ]) {
    let attempts = 0
    await expect(
      retryDatasetMergeCommit({ dataset }, { retryOnConflict: true }, async () => {
        attempts += 1
        throw failure
      })
    ).rejects.toBe(failure)
    expect(attempts).toBe(1)
  }
})

test("cancellation prevents another commit attempt", async () => {
  const controller = new AbortController()
  const cancelled = new Error("delivery cancelled")
  let attempts = 0
  await expect(
    retryDatasetMergeCommit(
      { dataset },
      { retryOnConflict: true, signal: controller.signal },
      async () => {
        attempts += 1
        controller.abort(cancelled)
        throw new LakeConcurrencyError("stale")
      }
    )
  ).rejects.toBe(cancelled)
  expect(attempts).toBe(1)
})
