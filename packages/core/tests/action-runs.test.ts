import { describe, expect, test } from "bun:test"
import { ActionRunError, InMemoryActionRunStorage } from "../src/storage"

describe("InMemoryActionRunStorage", () => {
  test("queues, starts, and finishes a successful action run", async () => {
    const storage = new InMemoryActionRunStorage()
    const queuedAt = new Date("2026-04-29T10:14:00.000Z")
    const startedAt = new Date("2026-04-29T10:14:01.000Z")
    const finishedAt = new Date("2026-04-29T10:14:03.842Z")

    const queued = await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      params: { amount: 50_000 },
      idempotencyKey: "action:my-app:act_1",
      queuedAt,
    })

    ;(queued.params as { amount: number }).amount = 1

    const started = await storage.start({
      id: "act_1",
      projectId: "my-app",
      startedAt,
    })

    ;(started.params as { amount: number }).amount = 1

    const finished = await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      finishedAt,
    })

    expect(finished).toMatchObject({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-123" },
      status: "succeeded",
      phase: "validation",
      params: { amount: 50_000 },
      idempotencyKey: "action:my-app:act_1",
    })
    expect(finished.queuedAt.toISOString()).toBe(queuedAt.toISOString())
    expect(finished.startedAt?.toISOString()).toBe(startedAt.toISOString())
    expect(finished.finishedAt?.toISOString()).toBe(finishedAt.toISOString())
  })

  test("rejects duplicate queues, invalid starts, and missing finishes", async () => {
    const storage = new InMemoryActionRunStorage()

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
          phase: "validation",
        },
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })

  test("rejects finishing terminal runs", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:my-app:act_1",
    })
    await storage.start({
      id: "act_1",
      projectId: "my-app",
    })
    await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      error: {
        message: "writeback failed",
        phase: "writeback",
      },
    })

    await expect(
      storage.finish({
        id: "act_1",
        projectId: "my-app",
        status: "succeeded",
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })

  test("stores failed runs and lists with filters, ordering, and paging", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-1" },
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
        phase: "writeback",
      },
    })

    await storage.queue({
      id: "act_2",
      projectId: "my-app",
      actionId: "sendQuote",
      subject: { kind: "object", objectTypeId: "Opportunity", primaryId: "opp-2" },
      params: {},
      idempotencyKey: "action:my-app:act_2",
      queuedAt: new Date("2026-04-29T10:59:59.000Z"),
    })
    await storage.start({
      id: "act_2",
      projectId: "my-app",
      startedAt: new Date("2026-04-29T11:00:00.000Z"),
    })

    await storage.queue({
      id: "act_3",
      projectId: "my-app",
      actionId: "closeOpportunity",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:my-app:act_3",
      queuedAt: new Date("2026-04-29T11:59:59.000Z"),
    })
    await storage.start({
      id: "act_3",
      projectId: "my-app",
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
      phase: "writeback",
    })
  })

  test("records V2 lifecycle records without failing committed actions on effects errors", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "createInvoice",
      subject: { kind: "none" },
      params: { amount: 42 },
      idempotencyKey: "action:my-app:act_1",
    })

    const started = await storage.start({
      id: "act_1",
      projectId: "my-app",
    })
    expect(started.phase).toBe("validation")

    const writeback = await storage.recordWriteback({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      result: { externalInvoiceId: "ext_1" },
      completedAt: new Date("2026-04-29T10:00:01.000Z"),
    })
    expect(writeback.writeback).toMatchObject({
      status: "succeeded",
      result: { externalInvoiceId: "ext_1" },
    })

    const effects = await storage.recordEffects({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      error: {
        name: "SlackError",
        message: "Slack timed out",
        phase: "effects",
      },
    })
    expect(effects.effects).toMatchObject({
      status: "failed",
      error: {
        name: "SlackError",
        message: "Slack timed out",
        phase: "effects",
      },
    })

    const finished = await storage.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
    })

    expect(finished).toMatchObject({
      status: "succeeded",
      phase: "effects",
      error: undefined,
      effects: {
        status: "failed",
      },
    })
  })

  test("compares phase records without stripping user result fields", async () => {
    const storage = new InMemoryActionRunStorage()

    await storage.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "createInvoice",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:my-app:act_1",
    })
    await storage.start({
      id: "act_1",
      projectId: "my-app",
    })

    const first = await storage.recordWriteback({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      completedAt: new Date("2026-04-29T10:00:00.000Z"),
      result: {
        externalInvoiceId: "ext_1",
        completedAt: "2026-04-29T10:00:00.000Z",
      },
    })

    const duplicate = await storage.recordWriteback({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      completedAt: new Date("2026-04-29T10:01:00.000Z"),
      result: {
        externalInvoiceId: "ext_1",
        completedAt: "2026-04-29T10:00:00.000Z",
      },
    })
    expect(duplicate.writeback?.completedAt.toISOString()).toBe(
      first.writeback?.completedAt.toISOString()
    )

    await expect(
      storage.recordWriteback({
        id: "act_1",
        projectId: "my-app",
        status: "succeeded",
        result: {
          externalInvoiceId: "ext_1",
          completedAt: "2026-04-29T10:02:00.000Z",
        },
      })
    ).rejects.toBeInstanceOf(ActionRunError)
  })
})
