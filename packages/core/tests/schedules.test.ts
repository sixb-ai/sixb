import { describe, expect, test } from "bun:test"
import { col, defineConnector, defineDataset, defineSync, SixbHost } from "../src"
import { emptyGrantIndex, type GrantIndex } from "../src/authorization"
import {
  CronValidationError,
  defineSchedule,
  isScheduleDefinition,
  ScheduleValidationError,
} from "../src/schedules"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

describe("defineSchedule", () => {
  test.each([
    [
      "an empty id",
      () => defineSchedule(""),
      ScheduleValidationError,
      "Schedule id must not be empty",
    ],
    [
      "a whitespace-only id",
      () => defineSchedule("   "),
      ScheduleValidationError,
      "Schedule id must not be empty",
    ],
    [
      "an empty cron expression",
      () => defineSchedule("s1").cron(""),
      ScheduleValidationError,
      "Schedule cron expression must not be empty",
    ],
    [
      "an invalid cron expression",
      () => defineSchedule("s1").cron("not-a-cron"),
      CronValidationError,
      "Invalid cron expression",
    ],
    [
      "an invalid timezone",
      () => defineSchedule("s1").cron("0 * * * *", { timezone: "Invalid/TZ" }),
      ScheduleValidationError,
      "Invalid timezone 'Invalid/TZ'",
    ],
  ] as const)("rejects %s", (_name, define, ErrorClass, message) => {
    expect(define).toThrow(ErrorClass)
    expect(define).toThrow(message)
  })

  test("builds a cron schedule definition, keeping a timezone only when given", () => {
    const schedule = defineSchedule("nightly-sync").cron("0 0 * * *")

    expect(schedule.kind).toBe("schedule")
    expect(schedule.id).toBe("nightly-sync")
    expect(schedule.trigger).toEqual({ type: "cron", expression: "0 0 * * *" })
    expect("timezone" in schedule.trigger).toBe(false)

    expect(
      defineSchedule("paris-sync").cron("0 0 * * *", { timezone: "Europe/Paris" }).trigger
    ).toEqual({ type: "cron", expression: "0 0 * * *", timezone: "Europe/Paris" })
  })
})

test.each([
  ["a defined schedule", defineSchedule("s1").cron("0 * * * *"), true],
  ["null", null, false],
  ["a wrong kind", { kind: "sync", id: "s1", trigger: { type: "cron" } }, false],
  ["a missing trigger", { kind: "schedule", id: "s1" }, false],
  ["a missing id", { kind: "schedule", trigger: { type: "cron" } }, false],
] as const)("isScheduleDefinition recognizes %s", (_name, value, expected) => {
  expect(isScheduleDefinition(value)).toBe(expected)
})

describe("sixb.schedules.run", () => {
  const nightly = defineSchedule("nightly").cron("0 2 * * *")
  const erp = defineConnector("erp", { type: "sql", connect: () => ({}) })
  const rawInvoices = defineDataset("raw.invoices", { schema: [col("id", "string")] })
  const importInvoices = defineSync("import-invoices")
    .when(nightly)
    .from(erp)
    .read(() => [])
    .intoDataset(rawInvoices)

  function project() {
    return new SixbHost({
      id: "schedules-run",
      ...createTestRuntimeDeps(),
      ontology: [],
      connectors: [erp],
      datasets: [rawInvoices],
      syncs: [importInvoices],
      schedules: [nightly],
    })
  }

  function personWith(host: SixbHost, grants: Partial<GrantIndex>) {
    return createTestSixb(host, {
      authorization: {
        principal: { type: "user", id: "usr_ada" },
        groupIds: [],
        roleIds: [],
        grants: { ...emptyGrantIndex(), ...grants },
      },
    })
  }

  async function triggered(host: SixbHost) {
    const events = await host.events.read({ limit: 10 })
    return events.filter((event) => event.type === "schedule.triggered")
  }

  // What a schedule starts runs as on its clock, not as the caller: a member who may run the
  // sync for their own account would start it for everyone's. Guard check: drop the
  // `source.manage` assertion from `SchedulesRuntime.run` (`schedules/execution.ts`): Ada fires
  // the schedule with the sync's run grant alone.
  test("takes managing the project's source, besides the run grant of what it starts", async () => {
    const host = project()
    const runsTheSync: Partial<GrantIndex> = { "run:sync": new Set([importInvoices.id]) }

    const ada = personWith(host, runsTheSync)
    expect(String(await ada.schedules.run(nightly.id).catch((error) => error))).toContain(
      "not allowed to manage the project's source"
    )

    const developer = personWith(host, { "manage:source": true })
    expect(String(await developer.schedules.run(nightly.id).catch((error) => error))).toContain(
      "not allowed to run sync 'import-invoices'"
    )

    expect(await triggered(host)).toEqual([])

    const both = personWith(host, { ...runsTheSync, "manage:source": true })
    const run = await both.schedules.run(nightly.id)

    expect((await triggered(host)).map((event) => event.payload)).toEqual([
      {
        scheduleId: nightly.id,
        occurrenceAt: run.triggeredAt,
        triggeredAt: run.triggeredAt,
        occurrenceKey: run.occurrenceKey,
      },
    ])
  })
})
