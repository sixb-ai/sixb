import { describe, expect, test } from "bun:test"
import type { ActivityStorage, AppendActivityInput } from "../storage/activity/types"
import type { Storage } from "../storage/types"

export interface ActivityStorageContractSuiteOptions<TStorage extends Storage = Storage> {
  /** A whole storage, so the suite can also check transaction rollback. */
  readonly createStorage: () => TStorage | Promise<TStorage>
  readonly cleanup?: (storage: TStorage) => void | Promise<void>
  /** Deletes one visit with its page views, as removing a user's history will. */
  readonly deleteVisit: (
    storage: TStorage,
    visit: { readonly projectId: string; readonly id: string }
  ) => Promise<void>
}

const projectId = "activity-contract"
const at = new Date("2026-10-01T23:59:00.000Z")
const midnight = new Date("2026-10-02T00:00:00.000Z")
const minute = 60_000
const period = {
  projectId,
  from: new Date(at.getTime() - 1_000),
  to: new Date(at.getTime() + 24 * 60 * minute),
}

/** Provider-neutral visit assignment, retry, quota, counting and isolation contract. */
export function runActivityStorageContractSuite<TStorage extends Storage>(
  label: string,
  options: ActivityStorageContractSuiteOptions<TStorage>
): void {
  const withActivity = async (
    run: (activity: ActivityStorage, storage: TStorage) => Promise<void>
  ): Promise<void> => {
    const storage = await options.createStorage()
    try {
      if (!storage.activity) {
        throw new Error("[Sixb] The storage under test has no activity slot.")
      }
      await run(storage.activity, storage)
    } finally {
      await options.cleanup?.(storage)
    }
  }

  describe(label, () => {
    // Guard proof: store each batch's attribution on the visit; the original source is replaced.
    test("arrival attribution is fixed by the first event and retry-safe", async () => {
      await withActivity(async (activity) => {
        const attribution = { source: "newsletter", medium: "email", campaign: "launch" }
        const first = batch("arrival", {
          events: [{ id: "arrival", type: "page.view", route: "/", attribution }],
        })
        await activity.append(first)

        const reordered = { campaign: "launch", source: "newsletter", medium: "email" }
        await expect(
          activity.append({
            ...first,
            events: [{ ...pageView("arrival", "/"), attribution: reordered }],
          })
        ).resolves.toEqual({ status: "accepted", accepted: 0 })
        await expect(
          activity.append({ ...first, events: [{ ...pageView("arrival", "/"), attribution: {} }] })
        ).rejects.toThrow("different content")

        attribution.source = "mutated-after-append"
        await activity.append(
          batch("other-tab", {
            now: later(2),
            events: [{ ...pageView("other-tab", "/next"), attribution: { source: "another" } }],
          })
        )

        // The other tab continued the visit past midnight; the next day lists its first arrival.
        const nextDay = await activity.list({ ...period, from: midnight, limit: 10 })
        expect(nextDay.visits.map((visit) => visit.attribution)).toEqual([
          { source: "newsletter", medium: "email", campaign: "launch" },
        ])

        // Activity after inactivity starts a direct visit, on its page; an event without any
        // attribution is not collected.
        await activity.append(
          batch("resumed", {
            now: later(40),
            events: [{ id: "resumed", type: "visit.activity", route: "/next", attribution: {} }],
          })
        )
        await activity.append(batch("legacy", { sessionId: "old-client" }))
        await expect(read(activity, "visit-resumed")).resolves.toMatchObject({
          visit: { attribution: {}, pageViews: 1 },
          pageViews: [{ id: "resumed", sequence: 1, route: "/next" }],
        })
        await expect(read(activity, "visit-legacy")).resolves.toMatchObject({
          visit: { attribution: null },
        })
      })
    })

    test("invalid attribution cannot partially mutate storage", async () => {
      await withActivity(async (activity) => {
        for (const attribution of [
          { source: "x".repeat(101) },
          { medium: "bad\nlabel" },
          { referrer: "https://example.com/private?token=secret" },
          { referrer: "UPPER.example" },
        ]) {
          await expect(
            activity.append(batch("bad", { events: [{ ...pageView("bad"), attribution }] }))
          ).rejects.toThrow("[Sixb]")
        }
        expect((await activity.summarize(period)).visits).toBe(0)

        await activity.append(
          batch("shared-referral", {
            sessionId: "shared-session",
            actor: { type: "share", grantId: "grant" },
            events: [
              { ...pageView("shared-referral"), attribution: { referrer: "partner.example" } },
            ],
          })
        )
        const visits = await activity.list({ ...period, limit: 1 })
        expect(visits.visits[0]?.attribution).toEqual({ referrer: "partner.example" })
      })
    })

    // Guard proof: make planActivityAppend's inactivity comparison always continue the visit.
    test("retried page views neither repeat nor prolong a visit; inactivity starts another", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("first"))
        await expect(activity.append(batch("first", { now: later(29) }))).resolves.toEqual({
          status: "accepted",
          accepted: 0,
        })
        await activity.append(batch("second", { now: later(30) }))

        const page = await activity.list({ ...period, limit: 10 })
        expect(page.visits.map((visit) => [visit.id, visit.pageViews])).toEqual([
          ["visit-second", 1],
          ["visit-first", 1],
        ])
        expect(page.visits[1]?.lastSeenAt).toEqual(at)
      })
    })

    // Guard proof: insert visit.activity events as page views; the timeline and counts grow.
    test("activity keeps a visit alive without adding a page view", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("view"))
        await expect(activity.append(heartbeat("pulse-1", later(20)))).resolves.toEqual({
          status: "accepted",
          accepted: 1,
        })
        await activity.append(heartbeat("pulse-2", later(45)))
        await activity.append(batch("still-same-visit", { now: later(70) }))

        const visits = await activity.list({ ...period, limit: 10 })
        expect(visits.visits).toHaveLength(1)
        expect(visits.visits[0]).toMatchObject({
          id: "visit-view",
          startedAt: at,
          lastSeenAt: later(70),
          pageViews: 2,
        })

        const timeline = await read(activity, "visit-view")
        expect(timeline?.pageViews.map((view) => [view.id, view.sequence])).toEqual([
          ["view", 1],
          ["still-same-visit", 2],
        ])
        expect(await activity.summarize(period)).toMatchObject({ visits: 1, pageViews: 2 })

        // Activity is not stored, so its id is free and a retry of it counts again.
        await expect(activity.append(heartbeat("pulse-1", later(71)))).resolves.toEqual({
          status: "accepted",
          accepted: 1,
        })
        await expect(activity.append(heartbeat("view", later(72), "/other"))).rejects.toThrow(
          "different content"
        )
      })
    })

    // Guard proof: filter planActivityAppend's page views on `page.view` alone; the visit opened
    // by activity has no page, and its retry adds one.
    test("activity that opens a visit records its page once, and its retry is recognized", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("first"))
        const returning = heartbeat("back", later(45), "/reports")

        await expect(activity.append(returning)).resolves.toEqual({
          status: "accepted",
          accepted: 1,
        })
        await expect(
          activity.append({ ...returning, now: later(46), newVisitId: "visit-retry" })
        ).resolves.toEqual({ status: "accepted", accepted: 0 })

        const visit = await read(activity, "visit-back")
        expect(visit?.visit).toMatchObject({ startedAt: later(45), pageViews: 1 })
        expect(visit?.pageViews.map((view) => [view.id, view.sequence, view.route])).toEqual([
          ["back", 1, "/reports"],
        ])
        await expect(read(activity, "visit-retry")).resolves.toBeNull()
      })
    })

    // Guard proof: drop the age check from continuesVisit; the second day joins the first visit.
    test("a visit ends at its next event once a day old", async () => {
      await withActivity(async (activity) => {
        const allDay = { idleTimeoutMs: 24 * 60 * minute }
        await activity.append(batch("morning", allDay))
        await activity.append(batch("evening", { ...allDay, now: later(23 * 60) }))
        await activity.append(batch("next-day", { ...allDay, now: later(24 * 60 + 1) }))

        const lateOnFirstDay = { ...period, from: later(22 * 60), to: later(23 * 60 + 1) }
        const visits = await activity.list({ ...lateOnFirstDay, limit: 10 })
        expect(visits.visits.map((visit) => [visit.id, visit.pageViews])).toEqual([
          ["visit-morning", 2],
        ])

        const nextDay = await activity.list({
          ...period,
          from: later(24 * 60),
          to: later(25 * 60),
          limit: 10,
        })
        expect(nextDay.visits.map((visit) => visit.id)).toEqual(["visit-next-day"])
      })
    })

    // Guard proof: drop the Math.max in planActivityAppend; the visit and its page move back.
    test("a server clock stepping back never moves a visit back", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("first", { now: later(10) }))
        await activity.append(batch("earlier", { now: later(5) }))

        const timeline = await read(activity, "visit-first")
        expect(timeline?.visit.lastSeenAt).toEqual(later(10))
        expect(timeline?.pageViews.map((view) => [view.id, view.receivedAt])).toEqual([
          ["first", later(10)],
          ["earlier", later(10)],
        ])
      })
    })

    // Guard proof: have the provider report a deleted visit's start as its source's last activity;
    // the next batch then adds to the missing visit and fails.
    test("a session whose visit was deleted starts another", async () => {
      await withActivity(async (activity, storage) => {
        await activity.append(batch("first"))
        await options.deleteVisit(storage, { projectId, id: "visit-first" })

        await activity.append(batch("second", { now: later(1) }))

        await expect(read(activity, "visit-first")).resolves.toBeNull()
        const visit = await read(activity, "visit-second")
        expect(visit?.visit).toMatchObject({ startedAt: later(1), pageViews: 1 })
        expect(visit?.pageViews.map((view) => [view.id, view.sequence])).toEqual([["second", 1]])
      })
    })

    test("concurrent tabs of one session share a visit and its sequence", async () => {
      await withActivity(async (activity) => {
        await Promise.all(
          Array.from({ length: 10 }, (_, index) => activity.append(batch(`tab-${index}`)))
        )

        const visits = await activity.list({ ...period, limit: 10 })
        expect(visits.visits).toHaveLength(1)
        expect(visits.visits[0]?.pageViews).toBe(10)

        const timeline = await read(activity, visits.visits[0]?.id ?? "", 100)
        expect(timeline?.pageViews.map((view) => view.sequence)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ])
      })
    })

    test("each session has its own visit; an account counts once and shares apart", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))
        await activity.append(batch("b", { sessionId: "session-b" }))
        await activity.append(
          batch("c", { sessionId: "share-session", actor: { type: "share", grantId: "grant" } })
        )
        // The same id in another kind of session is another source.
        await activity.append(
          batch("d", { sessionId: "session-a", actor: { type: "share", grantId: "grant" } })
        )

        expect(await activity.summarize(period)).toEqual({
          users: 1,
          visits: 4,
          sharedVisits: 2,
          pageViews: 4,
        })
        expect((await activity.list({ ...period, projectId: "other", limit: 10 })).visits).toEqual(
          []
        )
        await expect(read(activity, "visit-a", 10, "other")).resolves.toBeNull()

        // Core joins a visit with its session's executions and device through this id.
        expect((await read(activity, "visit-a"))?.sessionId).toBe("session-a")
        expect((await read(activity, "visit-d"))?.sessionId).toBe("session-a")
      })
    })

    test("a session's visits count whole, the latest first, for one account only", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("first"))
        await activity.append(batch("second", { now: later(31) }))
        await activity.append(batch("third", { now: later(62) }))
        await activity.append(batch("other-session", { sessionId: "session-b" }))
        await activity.append(
          batch("share", { sessionId: "session-c", actor: { type: "share", grantId: "grant" } })
        )
        await activity.append(
          batch("other-user", { sessionId: "session-d", actor: { type: "user", userId: "user-b" } })
        )

        const sessions = await activity.sessionVisits({
          projectId,
          userId: "user-a",
          sessionIds: ["session-a", "session-b", "session-c", "session-d", "missing"],
          limit: 2,
        })

        expect(
          [...sessions]
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
            .map((session) => ({
              sessionId: session.sessionId,
              visits: session.visits,
              latest: session.latest.map((visit) => visit.id),
            }))
        ).toEqual([
          { sessionId: "session-a", visits: 3, latest: ["visit-third", "visit-second"] },
          { sessionId: "session-b", visits: 1, latest: ["visit-other-session"] },
        ])
        await expect(
          activity.sessionVisits({
            projectId: "other",
            userId: "user-a",
            sessionIds: ["session-a"],
            limit: 2,
          })
        ).resolves.toEqual([])
      })
    })

    // Guard proof: drop the provider's userId predicate; the share and the other account leak in.
    test("user filters apply before pagination and summary, never to shares", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))
        await activity.append(batch("b", { sessionId: "second-session" }))
        await activity.append(
          batch("c", { sessionId: "another-user", actor: { type: "user", userId: "user-b" } })
        )
        await activity.append(
          batch("d", { sessionId: "share-session", actor: { type: "share", grantId: "user-a" } })
        )
        await activity.append(batch("e", { projectId: "other" }))

        const filtered = { ...period, userId: "user-a" }
        expect(await activity.summarize(filtered)).toEqual({
          users: 1,
          visits: 2,
          sharedVisits: 0,
          pageViews: 2,
        })

        const first = await activity.list({ ...filtered, limit: 1 })
        expect(first.hasMore).toBe(true)
        expect(first.visits[0]?.actor).toEqual({ type: "user", userId: "user-a" })

        const last = first.visits[0]
        if (!last) throw new Error("Expected a first visit.")
        const second = await activity.list({
          ...filtered,
          limit: 1,
          before: { at: last.lastSeenAt, id: last.id },
        })
        expect(second.hasMore).toBe(false)
        expect(new Set([...first.visits, ...second.visits].map((visit) => visit.id))).toEqual(
          new Set(["visit-a", "visit-b"])
        )

        expect(await activity.summarize({ ...period, userId: "unknown" })).toEqual({
          users: 0,
          visits: 0,
          sharedVisits: 0,
          pageViews: 0,
        })
      })
    })

    test("users count their sessions once and page through equal timestamps without shares", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))
        await activity.append(batch("b", { sessionId: "second-session" }))
        await activity.append(
          batch("c", { sessionId: "user-b", actor: { type: "user", userId: "user-b" } })
        )
        await activity.append(
          batch("d", { sessionId: "share-session", actor: { type: "share", grantId: "user-b" } })
        )
        await activity.append(batch("e", { projectId: "other" }))

        const first = await activity.users({ ...period, limit: 1 })
        expect(first).toEqual({
          users: [{ userId: "user-b", lastSeenAt: at, visits: 1, pageViews: 1 }],
          hasMore: true,
        })

        const second = await activity.users({ ...period, limit: 1, before: { id: "user-b", at } })
        expect(second).toEqual({
          users: [{ userId: "user-a", lastSeenAt: at, visits: 2, pageViews: 2 }],
          hasMore: false,
        })

        expect((await activity.users({ ...period, projectId: "empty", limit: 10 })).users).toEqual(
          []
        )
        expect((await activity.users({ ...period, userId: "user-a", limit: 10 })).users).toEqual(
          second.users
        )
      })
    })

    // Guard proof: select visits by page views in the period instead of by overlap; the visit
    // active after midnight disappears from the second day.
    test("a visit counts in every period it overlaps, page views only where received", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))
        await activity.append(heartbeat("pulse", midnight))

        const afterMidnight = { ...period, from: midnight }
        expect(await activity.summarize(afterMidnight)).toEqual({
          users: 1,
          visits: 1,
          sharedVisits: 0,
          pageViews: 0,
        })
        expect(await activity.users({ ...afterMidnight, limit: 10 })).toEqual({
          users: [{ userId: "user-a", lastSeenAt: midnight, visits: 1, pageViews: 0 }],
          hasMore: false,
        })

        const visits = await activity.list({ ...afterMidnight, limit: 10 })
        expect(visits.visits[0]).toMatchObject({
          startedAt: at,
          lastSeenAt: midnight,
          pageViews: 1,
        })

        const beforeVisit = { ...period, from: new Date(at.getTime() - minute), to: at }
        expect((await activity.summarize(beforeVisit)).visits).toBe(0)
      })
    })

    test("visit cursors do not lose equal-timestamp records", async () => {
      await withActivity(async (activity) => {
        for (const id of ["a", "b", "c"]) {
          await activity.append(batch(id, { sessionId: id }))
        }

        const first = await activity.list({ ...period, limit: 2 })
        expect(first.hasMore).toBe(true)

        const last = first.visits.at(-1)
        if (!last) throw new Error("Expected a last visit.")
        const next = await activity.list({
          ...period,
          limit: 2,
          before: { at: last.lastSeenAt, id: last.id },
        })
        expect(new Set([...first.visits, ...next.visits].map((visit) => visit.id)).size).toBe(3)
        expect(next.hasMore).toBe(false)
      })
    })

    test("the timeline pages through a visit by sequence", async () => {
      await withActivity(async (activity) => {
        for (const id of ["one", "two", "three"]) {
          await activity.append(batch(id, { newVisitId: "visit-timeline" }))
        }

        const first = await read(activity, "visit-timeline", 2)
        expect(first?.pageViews.map((view) => view.route)).toEqual([
          "/invoices/:id",
          "/invoices/:id",
        ])
        expect(first?.hasMore).toBe(true)

        const rest = await activity.read({
          projectId,
          id: "visit-timeline",
          afterSequence: 2,
          limit: 2,
        })
        expect(rest?.pageViews.map((view) => [view.id, view.sequence])).toEqual([["three", 3]])
        expect(rest?.hasMore).toBe(false)
      })
    })

    test("the quota is atomic, counts activity, and ignores retried page views", async () => {
      await withActivity(async (activity) => {
        for (let round = 0; round < 5; round++) {
          await activity.append(
            batch(`q${round}`, {
              events: Array.from({ length: 20 }, (_, index) => pageView(`q${round}-${index}`)),
            })
          )
        }
        await activity.append(
          batch("pulses", {
            events: Array.from({ length: 20 }, (_, index) => ({
              id: `pulse-${index}`,
              type: "visit.activity" as const,
              route: "/",
            })),
          })
        )

        await expect(activity.append(batch("q0-0"))).resolves.toEqual({
          status: "accepted",
          accepted: 0,
        })
        await expect(activity.append(batch("over"))).resolves.toEqual({
          status: "throttled",
          accepted: 0,
        })
        await expect(activity.append(batch("after", { now: later(1) }))).resolves.toEqual({
          status: "accepted",
          accepted: 1,
        })
      })
    })

    test("invalid and conflicting batches cannot partially mutate activity", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))

        await expect(
          activity.append(batch("a", { events: [pageView("a", "/other")] }))
        ).rejects.toThrow("different content")
        await expect(
          activity.append(batch("b", { events: [pageView("b", "/secret?token=value")] }))
        ).rejects.toThrow("[Sixb]")
        await expect(
          activity.append(batch("c", { events: [pageView("c"), pageView("a", "/other")] }))
        ).rejects.toThrow("different content")

        expect(await activity.summarize(period)).toMatchObject({ visits: 1, pageViews: 1 })
      })
    })

    test("activity follows the storage transaction rollback contract", async () => {
      await withActivity(async (activity, storage) => {
        await expect(
          storage.transaction(async (tx) => {
            await tx.activity?.append(batch("a"))
            throw new Error("rollback")
          })
        ).rejects.toThrow("rollback")
        expect((await activity.summarize(period)).visits).toBe(0)

        await activity.append(batch("b"))
        expect((await activity.list({ ...period, limit: 10 })).visits[0]?.id).toBe("visit-b")
      })
    })

    test("UTC days count a visit on both sides of midnight and its page views once", async () => {
      await withActivity(async (activity) => {
        await activity.append(batch("a"))
        await activity.append(heartbeat("pulse", midnight))
        await activity.append(batch("b", { now: midnight, sessionId: "second-session" }))
        await activity.append(
          batch("c", {
            now: midnight,
            sessionId: "other-user",
            actor: { type: "user", userId: "user-b" },
          })
        )
        await activity.append(
          batch("d", {
            now: midnight,
            sessionId: "share",
            actor: { type: "share", grantId: "user-a" },
          })
        )
        await activity.append(batch("e", { now: midnight, projectId: "other" }))
        // A retry adds neither a day nor a page view.
        await activity.append(
          batch("b", { now: new Date(midnight.getTime() + 1), sessionId: "second-session" })
        )

        const year = {
          projectId,
          userId: "user-a",
          from: new Date("2026-01-01T00:00:00.000Z"),
          to: new Date("2027-01-01T00:00:00.000Z"),
        }
        expect(await activity.calendar(year)).toEqual([
          { day: "2026-10-01", visits: 1, pageViews: 1 },
          { day: "2026-10-02", visits: 2, pageViews: 1 },
        ])
        expect(await activity.calendar({ ...year, to: midnight })).toEqual([
          { day: "2026-10-01", visits: 1, pageViews: 1 },
        ])
        expect(await activity.calendar({ ...year, userId: "unknown" })).toEqual([])
      })
    })
  })
}

function batch(event: string, overrides: Partial<AppendActivityInput> = {}): AppendActivityInput {
  return {
    projectId,
    actor: { type: "user", userId: "user-a" },
    sessionId: "session-a",
    events: [pageView(event)],
    now: at,
    idleTimeoutMs: 30 * minute,
    newVisitId: `visit-${event}`,
    ...overrides,
  }
}

function pageView(id: string, route = "/invoices/:id") {
  return { id, type: "page.view" as const, route }
}

function heartbeat(id: string, now: Date, route = "/invoices/:id"): AppendActivityInput {
  return batch(id, { now, events: [{ id, type: "visit.activity", route }] })
}

function later(minutes: number): Date {
  return new Date(at.getTime() + minutes * minute)
}

function read(activity: ActivityStorage, id: string, limit = 10, project = projectId) {
  return activity.read({ projectId: project, id, afterSequence: 0, limit })
}
