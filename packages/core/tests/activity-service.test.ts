import { expect, test } from "bun:test"
import { ActivityService } from "../src/activity/service"
import { InMemoryActivityStorage } from "../src/storage/activity"

const user = { actor: { type: "user" as const, userId: "u" }, sessionId: "ses_1" }
const range = { from: new Date("2024-02-29T00:00:00Z"), to: new Date("2024-03-01T00:00:00Z") }

// Regression proof: clamp period() to the last 30 days; the old period reads empty.
test("history and the calendar stay readable years after collection", async () => {
  let now = new Date("2024-02-29T23:59:00Z")
  const storage = new InMemoryActivityStorage()
  const service = new ActivityService("p", storage, { enabled: true }, () => now)

  await service.capture(user, [{ id: "old", type: "page.view", route: "/" }])
  now = new Date("2026-10-07T00:00:00Z")

  expect(await service.summarize(range)).toEqual({
    users: 1,
    visits: 1,
    sharedVisits: 0,
    pageViews: 1,
  })

  const visits = await service.list(range)
  expect(visits.visits).toHaveLength(1)
  const visit = await service.readWithSession({ id: visits.visits[0]?.id ?? "", limit: 10 })
  expect(visit?.pageViews[0]?.id).toBe("old")

  expect(await service.calendar({ userId: "u", year: 2024 })).toEqual({
    userId: "u",
    year: 2024,
    days: [{ day: "2024-02-29", visits: 1, pageViews: 1 }],
  })
  expect((await service.calendar({ userId: "u", year: 2026 })).days).toEqual([])
})

test("disabled collection records nothing and keeps history readable", async () => {
  const storage = new InMemoryActivityStorage()
  const enabled = new ActivityService("p", storage, { enabled: true }, () => range.from)
  await enabled.capture(user, [{ id: "kept", type: "page.view", route: "/" }])

  const disabled = new ActivityService("p", storage)
  await expect(
    disabled.capture(user, [{ id: "new", type: "page.view", route: "/" }])
  ).resolves.toEqual({ status: "disabled", accepted: 0 })
  expect((await disabled.summarize(range)).pageViews).toBe(1)
})

test("the service validates settings, identifiers, periods and calendar years", async () => {
  const storage = new InMemoryActivityStorage()
  const service = new ActivityService("p", storage)

  expect(() => new ActivityService("p", undefined, { enabled: true })).toThrow("activity store")
  expect(() => new ActivityService("p", storage, { idleTimeoutMs: 59_999 })).toThrow(
    "idleTimeoutMs"
  )
  expect(() => service.list({ ...range, limit: 1000 })).toThrow("page size")
  expect(() => service.list({ from: range.from, to: new Date("2024-04-01T00:00:00Z") })).toThrow(
    "31 days"
  )
  expect(() => service.readWithSession({ id: "../other", limit: 1 })).toThrow("visit id")

  for (const userId of ["", "   ", "x".repeat(257)]) {
    expect(() => service.list({ ...range, userId })).toThrow("userId")
    expect(() => service.summarize({ ...range, userId })).toThrow("userId")
    await expect(service.calendar({ userId, year: 2026 })).rejects.toThrow("userId")
  }

  for (const year of [1969, 9999, 2026.5, Number.NaN]) {
    await expect(service.calendar({ userId: "u", year })).rejects.toThrow("year")
  }
})
