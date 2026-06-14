import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ActionRunError } from "@sixb/core"
import { SqliteActionRunStorage } from "../src"

describe("SqliteActionRunStorage", () => {
  let storage: SqliteActionRunStorage

  beforeEach(() => {
    storage = new SqliteActionRunStorage()
  })

  afterEach(() => {
    storage.close()
  })

  test("queues, starts, and finishes runs", async () => {
    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: {
        amount: 50_000,
      },
      idempotencyKey: "action:my-app:act_1",
      queuedAt: new Date("2026-04-29T10:14:00.000Z"),
    })

    await storage.start({
      id: "act_1",
      projectId: "my-app",
      startedAt: new Date("2026-04-29T10:14:01.000Z"),
    })

    const finished = await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt: new Date("2026-04-29T10:14:03.842Z"),
    })

    expect(finished.status).toBe("succeeded")
    expect(finished.phase).toBe("handler")
    expect(finished.params).toEqual({ amount: 50_000 })
    expect(finished.idempotencyKey).toBe("action:my-app:act_1")
    expect(finished.queuedAt.toISOString()).toBe("2026-04-29T10:14:00.000Z")
    expect(finished.startedAt?.toISOString()).toBe("2026-04-29T10:14:01.000Z")
  })

  test("stores failures and supports filtered paging", async () => {
    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: {},
      idempotencyKey: "action:my-app:act_1",
      queuedAt: new Date("2026-04-29T09:59:59.000Z"),
    })
    await storage.start({
      id: "act_1",
      projectId: "my-app",
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

    await storage.queue({
      id: "act_2",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:my-app:act_2",
      queuedAt: new Date("2026-04-29T10:59:59.000Z"),
    })
    await storage.start({
      id: "act_2",
      projectId: "my-app",
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
    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: {},
      idempotencyKey: "action:my-app:act_1",
    })

    await expect(
      storage.queue({
        id: "act_1",
        projectId: "my-app",
        actionId: "sendQuote",
        subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
        params: {},
        idempotencyKey: "action:my-app:act_1",
      })
    ).rejects.toBeInstanceOf(ActionRunError)

    await storage.start({
      id: "act_1",
      projectId: "my-app",
    })

    await expect(
      storage.start({
        id: "act_1",
        projectId: "my-app",
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

  test("requeues matching runs that failed during enqueue", async () => {
    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: { amount: 50_000 },
      idempotencyKey: "action:my-app:act_1",
      queuedAt: new Date("2026-04-29T10:00:00.000Z"),
    })
    await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      phase: "enqueue",
      finishedAt: new Date("2026-04-29T10:00:01.000Z"),
      error: {
        message: "queue unavailable",
        phase: "enqueue",
      },
    })

    const requeued = await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: { amount: 50_000 },
      idempotencyKey: "action:my-app:act_1",
      queuedAt: new Date("2026-04-29T10:00:02.000Z"),
    })

    expect(requeued).toMatchObject({
      status: "queued",
      phase: "request",
      error: undefined,
      finishedAt: undefined,
    })
    expect(requeued.queuedAt.toISOString()).toBe("2026-04-29T10:00:02.000Z")

    await expect(
      storage.queue({
        id: "act_1",
        projectId: "my-app",
        actionId: "sendQuote",
        subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
        params: { amount: 60_000 },
        idempotencyKey: "action:my-app:act_1",
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })
})
