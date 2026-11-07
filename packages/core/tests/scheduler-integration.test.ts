import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import { defineObjectType, defineSchedule, prop, SixbHost } from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Stub = defineObjectType({
  id: "Stub",
  name: "Stub",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const MINUTE = 60_000

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

// The host wiring only: the cron pass's own timing, idempotence and shutdown semantics are proven
// in cron-pass.test.ts.
test("startMaintenance emits the host's schedules to its events until stopped", async () => {
  const sixb = new SixbHost({
    ontology: [Stub],
    schedules: [defineSchedule("hourly").cron("0 * * * *")],
    ...createTestRuntimeDeps(),
  })

  const maintenance = sixb.startMaintenance([])
  jest.advanceTimersByTime(60 * MINUTE)

  const fired = await sixb.events.read({ types: ["schedule.triggered"] })
  expect(fired).toHaveLength(1)
  expect((fired[0] as StoredScheduleTriggeredEvent).payload.scheduleId).toBe("hourly")

  await maintenance.stop()
  jest.advanceTimersByTime(120 * MINUTE)

  expect(await sixb.events.read({ types: ["schedule.triggered"] })).toHaveLength(1)
})
