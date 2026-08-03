import { describe, expect, test } from "bun:test"
import {
  isPermanentProjectionWorkerError,
  projectionJobStale,
  projectionSchemaMismatch,
  projectionWorkerError,
} from "../src/errors"

describe("isPermanentProjectionWorkerError", () => {
  test("recognizes both permanent codes and no others", () => {
    expect(isPermanentProjectionWorkerError(projectionSchemaMismatch("column is gone"))).toBe(true)
    expect(isPermanentProjectionWorkerError(projectionJobStale("run already failed"))).toBe(true)
    expect(isPermanentProjectionWorkerError(projectionWorkerError("lake timed out"))).toBe(false)
    expect(isPermanentProjectionWorkerError(new Error("something else"))).toBe(false)
  })

  test("recognizes a permanent failure that crossed a bundle boundary", () => {
    // Why permanence rides on the code and not on `retryable`: that field lives on the thrown class
    // and is deliberately absent from the failure record, so a failure raised by another copy of the
    // runtime — or read back out of a run row — carries no `retryable` at all.
    //
    // To reproduce the behavior this replaces, put back
    // `isSixbError(error, "projection.failed") && error.retryable === false` and watch this fail:
    // `undefined === false` is false, so a permanent failure came back as retryable and the worker
    // redelivered a job that can never succeed.
    const foreign = {
      code: "projection.schema_mismatch",
      message: "[Sixb] column 'amount' is gone",
    }
    expect(foreign instanceof Error).toBe(false)
    expect(isPermanentProjectionWorkerError(foreign)).toBe(true)
  })
})
