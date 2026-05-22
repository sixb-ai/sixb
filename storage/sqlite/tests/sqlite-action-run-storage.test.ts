import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ActionRunError } from "@pario/core"
import { SqliteActionRunStorage } from "../src"

describe("SqliteActionRunStorage", () => {
  let storage: SqliteActionRunStorage

  beforeEach(() => {
    storage = new SqliteActionRunStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("starts and finishes runs with merged metadata", async () => {
    await storage.start({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-123",
      params: {
        amount: 50_000,
      },
      startedAt: new Date("2026-04-29T10:14:01.000Z"),
      metadata: {
        source: "ui",
      },
    })

    const finished = await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-29T10:14:03.842Z"),
      metadata: {
        durationMs: 2842,
      },
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.params).toEqual({ amount: 50_000 })
    expect(finished.metadata).toEqual({
      source: "ui",
      durationMs: 2842,
    })
  })

  test("stores failures and supports filtered paging", async () => {
    await storage.start({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      objectTypeId: "Opportunity",
      primaryId: "opp-123",
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
      primaryId: "opp-456",
      params: {},
      startedAt: new Date("2026-04-29T11:00:00.000Z"),
    })

    const page = await storage.list({
      projectId: "my-app",
      actionId: "sendQuote",
      statuses: ["running"],
      limit: 1,
    })

    expect(page.total).toBe(1)
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

  test("rejects duplicates and missing runs", async () => {
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
        },
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })
})
