import { describe, expect, test } from "bun:test"
import { canFinishPipelineRun, canFinishSyncRun } from "../src/storage/internal"

const run = { id: "run-1", projectId: "test" }
const failure = (code: "internal.unexpected" | "queue.enqueue_failed") => ({
  code,
  message: "Failed",
  retryable: false,
  at: "2026-11-04T10:00:00.000Z",
})

// Every provider's `finish` guards its transition with these helpers.
describe.each([
  ["Pipeline", canFinishPipelineRun],
  ["Sync", canFinishSyncRun],
] as const)("%s run finish transitions", (_kind, canFinish) => {
  test("fails a run that never started, whatever ended its job", () => {
    const failed = { ...run, status: "failed" as const, error: failure("internal.unexpected") }

    expect(canFinish("queued", failed)).toBe(true)
    expect(canFinish("running", failed)).toBe(true)
    expect(canFinish("succeeded", failed)).toBe(false)
  })

  test("keeps an enqueue failure for a run that never started", () => {
    const failed = { ...run, status: "failed" as const, error: failure("queue.enqueue_failed") }

    expect(canFinish("queued", failed)).toBe(true)
    expect(canFinish("running", failed)).toBe(false)
  })

  test("succeeds only a running run", () => {
    const finished = { ...run, status: "succeeded" as const, rowsRead: 0 }

    expect(canFinish("queued", finished)).toBe(false)
    expect(canFinish("running", finished)).toBe(true)
    expect(canFinish("failed", finished)).toBe(false)
  })

  test("cancels a run that has not ended, started or not", () => {
    const cancelled = { ...run, status: "cancelled" as const }

    expect(canFinish("queued", cancelled)).toBe(true)
    expect(canFinish("running", cancelled)).toBe(true)
    expect(canFinish("failed", cancelled)).toBe(false)
  })
})
