import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineSchedule,
  InMemoryLakeStorage,
  prop,
  SixbHost,
} from "../src"
import type { StoredScheduleTriggeredEvent } from "../src/events"
import type { LakeMaintenance } from "../src/lake-storage"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const Stub = defineObjectType({
  id: "Stub",
  name: "Stub",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const rooms = defineDataset("raw.rooms", { schema: [col("id", "string")] })

const MINUTE = 60_000

class MaintainedLakeStorage extends InMemoryLakeStorage {
  readonly maintenance: LakeMaintenance = {
    applyRetention: async () => {
      throw new Error("the scheduler only requests retention")
    },
    describeStorage: async () => [],
  }
}

async function firedScheduleIds(sixb: SixbHost): Promise<string[]> {
  const fired = await sixb.events.read({ types: ["schedule.triggered"] })
  return fired.map((event) => (event as StoredScheduleTriggeredEvent).payload.scheduleId)
}

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

// Reproduce: leave the built-in schedule out of the SchedulerRuntime the host builds.
test("SixbHost.scheduler requests lake retention beside the project's schedules", async () => {
  jest.setSystemTime(new Date("2026-11-05T10:30:00.000Z"))
  const sixb = new SixbHost({
    ontology: [Stub],
    datasets: [rooms],
    schedules: [defineSchedule("hourly").cron("0 * * * *")],
    ...createTestRuntimeDeps(),
    lakeStorage: new MaintainedLakeStorage(),
    lakeMaintenance: { cleanupEvery: "30m" },
  })

  await sixb.scheduler.start()
  jest.advanceTimersByTime(30 * MINUTE)

  expect((await firedScheduleIds(sixb)).sort()).toEqual(["hourly", "sixb:lake-retention"])
  expect(sixb.definitions.schedules.list().map((schedule) => schedule.id)).toEqual(["hourly"])

  await sixb.scheduler.stop()
})

test("SixbHost.scheduler requests no lake retention when it is turned off", async () => {
  const sixb = new SixbHost({
    ontology: [Stub],
    datasets: [rooms],
    ...createTestRuntimeDeps(),
    lakeStorage: new MaintainedLakeStorage(),
    lakeMaintenance: { enabled: false },
  })

  await sixb.scheduler.start()
  jest.advanceTimersByTime(24 * 60 * MINUTE)

  expect(await firedScheduleIds(sixb)).toEqual([])
  await sixb.scheduler.stop()
})

// Reproduce: drop the reserved-id check from runtime/host.ts.
test("SixbHost refuses a project schedule with the lake retention schedule's id", () => {
  expect(
    () =>
      new SixbHost({
        ontology: [Stub],
        schedules: [defineSchedule("sixb:lake-retention").cron("0 * * * *")],
        ...createTestRuntimeDeps(),
      })
  ).toThrow("Schedule id 'sixb:lake-retention' is reserved for lake maintenance.")
})
