import { describe, expect, test } from "bun:test"
import {
  datasetUpdated,
  isRunTrigger,
  pipelineFinished,
  syncFinished,
  TriggerValidationError,
} from "../src"

describe("syncFinished", () => {
  test("returns a sync.finished trigger", () => {
    expect(syncFinished("sync-orders")).toEqual({
      type: "sync.finished",
      syncId: "sync-orders",
      status: "succeeded",
    })
  })

  test("rejects empty syncId", () => {
    expect(() => syncFinished("")).toThrow(TriggerValidationError)
    expect(() => syncFinished("   ")).toThrow("Trigger syncId must not be empty")
  })
})

describe("pipelineFinished", () => {
  test("returns a pipeline.finished trigger", () => {
    expect(pipelineFinished("normalize-orders")).toEqual({
      type: "pipeline.finished",
      pipelineId: "normalize-orders",
      status: "succeeded",
    })
  })

  test("rejects empty pipelineId", () => {
    expect(() => pipelineFinished("")).toThrow(TriggerValidationError)
    expect(() => pipelineFinished("  ")).toThrow("Trigger pipelineId must not be empty")
  })
})

describe("datasetUpdated", () => {
  test("returns a dataset.updated trigger", () => {
    expect(datasetUpdated("raw.erp.orders")).toEqual({
      type: "dataset.updated",
      datasetId: "raw.erp.orders",
    })
  })

  test("rejects empty datasetId", () => {
    expect(() => datasetUpdated("")).toThrow(TriggerValidationError)
    expect(() => datasetUpdated("  ")).toThrow("Trigger datasetId must not be empty")
  })
})

describe("isRunTrigger", () => {
  test("returns true for valid schedule trigger", () => {
    expect(isRunTrigger({ type: "schedule", scheduleId: "daily" })).toBe(true)
  })

  test("returns true for valid sync.finished trigger", () => {
    expect(isRunTrigger({ type: "sync.finished", syncId: "s1", status: "succeeded" })).toBe(true)
  })

  test("returns true for valid pipeline.finished trigger", () => {
    expect(isRunTrigger({ type: "pipeline.finished", pipelineId: "p1", status: "succeeded" })).toBe(
      true
    )
  })

  test("returns true for valid dataset.updated trigger", () => {
    expect(isRunTrigger({ type: "dataset.updated", datasetId: "raw.orders" })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isRunTrigger(null)).toBe(false)
  })

  test("returns false for unknown type", () => {
    expect(isRunTrigger({ type: "unknown", id: "x" })).toBe(false)
  })

  test("returns false for missing required fields", () => {
    expect(isRunTrigger({ type: "schedule" })).toBe(false)
    expect(isRunTrigger({ type: "sync.finished", syncId: "s1" })).toBe(false)
    expect(isRunTrigger({ type: "dataset.updated" })).toBe(false)
  })
})
