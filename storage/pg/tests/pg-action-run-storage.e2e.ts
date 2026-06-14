import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

describe("PgActionRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  test("persists V2 lifecycle records and recomposes relational commit diffs", async () => {
    await storage.actionRuns.queue({
      id: "act_1",
      projectId: "my-app",
      actionId: "createInvoice",
      subject: { kind: "none" },
      params: { amount: 42 },
      idempotencyKey: "action:my-app:act_1",
    })

    await storage.actionRuns.start({
      id: "act_1",
      projectId: "my-app",
    })

    await storage.actionRuns.recordWriteback({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
      result: { externalInvoiceId: "ext_1" },
      completedAt: new Date("2026-04-29T10:00:01.000Z"),
    })

    await storage.actionRuns.enterPhase({
      id: "act_1",
      projectId: "my-app",
      phase: "edits",
    })

    await storage.actionRuns.recordCommit({
      id: "act_1",
      projectId: "my-app",
      committedAt: new Date("2026-04-29T10:00:02.000Z"),
      diff: {
        objects: [
          {
            objectTypeId: "Invoice",
            primaryId: "inv_1",
            operation: "update",
            changedProperties: ["status", "paidAt", "status"],
          },
        ],
        links: [
          {
            operation: "update",
            source: { objectTypeId: "Invoice", primaryId: "inv_1" },
            linkId: "customer",
            target: { objectTypeId: "Customer", primaryId: "cus_1" },
          },
        ],
      },
    })

    await storage.actionRuns.recordEffects({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      error: {
        name: "SlackError",
        message: "Slack timed out",
        phase: "effects",
      },
    })

    await storage.actionRuns.finish({
      id: "act_1",
      projectId: "my-app",
      status: "succeeded",
    })

    const run = await storage.actionRuns.getById({
      projectId: "my-app",
      id: "act_1",
    })

    expect(run).toMatchObject({
      status: "succeeded",
      phase: "effects",
      error: undefined,
      writeback: {
        status: "succeeded",
        result: { externalInvoiceId: "ext_1" },
      },
      effects: {
        status: "failed",
        error: {
          name: "SlackError",
          message: "Slack timed out",
          phase: "effects",
        },
      },
    })
    expect(run?.commit?.diff).toEqual({
      objects: [
        {
          objectTypeId: "Invoice",
          primaryId: "inv_1",
          operation: "update",
          changedProperties: ["paidAt", "status"],
        },
      ],
      links: [
        {
          operation: "update",
          source: { objectTypeId: "Invoice", primaryId: "inv_1" },
          linkId: "customer",
          target: { objectTypeId: "Customer", primaryId: "cus_1" },
        },
      ],
    })

    const page = await storage.actionRuns.list({
      projectId: "my-app",
      actionId: "createInvoice",
      limit: 10,
    })
    expect(page.runs).toHaveLength(1)
    expect(page.runs[0]?.commit?.diff).toEqual(run?.commit?.diff)
  })
})
