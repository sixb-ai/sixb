import { describe, expect, test } from "bun:test"
import { ActionRunError, InMemoryActionRunStorage } from "../src"

describe("InMemoryActionRunStorage", () => {
  test("starts and finishes a successful action run with merged metadata", async () => {
    const storage = new InMemoryActionRunStorage()
    const startedAt = new Date("2026-04-29T10:14:01.000Z")
    const finishedAt = new Date("2026-04-29T10:14:03.842Z")

    const started = await storage.start({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-123",
      params: { amount: 50_000 },
      startedAt,
      metadata: {
        source: "ui",
      },
    })

    ;(started.params as { amount: number }).amount = 1

    const finished = await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
      metadata: {
        durationMs: 2842,
      },
    })

    expect(finished).toMatchObject({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-123",
      status: "succeeded",
      params: { amount: 50_000 },
      metadata: {
        source: "ui",
        durationMs: 2842,
      },
    })
    expect(finished.startedAt.toISOString()).toBe(startedAt.toISOString())
    expect(finished.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("rejects duplicate starts and missing finishes", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.start({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-123",
      params: {},
    })

    await expect(
      storage.start({
        id: "act_1",
        projectId: "my-app",
        actionId: "sendQuote",
        objectTypeId: "Opportunity",
        primaryId: "opp-123",
        params: {},
      })
    ).rejects.toBeInstanceOf(ActionRunError)

    await expect(
      storage.finish({
        id: "missing",
        projectId: "my-app",
        status: "failed",
        error: {
          message: "boom",
          phase: "handler",
        },
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })

  test("stores failed runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.start({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-1",
      params: {},
      startedAt: new Date("2026-04-29T10:00:00.000Z"),
    })
    await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      error: {
        name: "FetchError",
        message: "TeamLeader API returned 503 Service Unavailable",
        phase: "handler",
      },
    })

    await storage.start({
      id: "act_2",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-2",
      params: {},
      startedAt: new Date("2026-04-29T11:00:00.000Z"),
    })

    await storage.start({
      id: "act_3",
      projectId: "my-app",
      actionId: "closeOpportunity",
      objectTypeId: "Opportunity",
      primaryId: "opp-3",
      params: {},
      startedAt: new Date("2026-04-29T12:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      actionId: "sendQuote",
      statuses: ["running"],
      startedAfter: new Date("2026-04-29T10:30:00.000Z"),
      limit: 1,
    })

    expect(page.total).toBe(1)
    expect(page.hasMore).toBe(false)
    expect(page.runs.map((run) => run.id)).toEqual(["act_2"])

    const failed = await storage.getById({
      projectId: "my-app",
      id: "act_1",
    })
    expect(failed?.error).toEqual({
      name: "FetchError",
      message: "TeamLeader API returned 503 Service Unavailable",
      phase: "handler",
    })
  })
})
