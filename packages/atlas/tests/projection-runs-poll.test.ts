import { expect, test } from "bun:test"
import { projectionRunsPollInterval } from "../src/pages/ProjectionsPage"

const now = Date.UTC(2026, 9, 7, 12)

test("polls projection runs only while one is pending", () => {
  // Removal proof: return RUN_POLL_MS unconditionally (the old `refetchInterval: 5000`) and the
  // settled case polls again.
  expect(projectionRunsPollInterval([{ status: "queued" }], 0, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "running" }], 0, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "succeeded" }, { status: "failed" }], 0, now)).toBe(
    false
  )
})

test("polls after a source commit until its run can have been queued", () => {
  // The commit event arrives before the orchestrator persists the run it queues.
  expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 59_000, now)).toBe(5000)
  expect(projectionRunsPollInterval([{ status: "succeeded" }], now - 60_000, now)).toBe(false)
})
