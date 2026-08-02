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

    await storage.actionRuns.recordEffects({
      id: "act_1",
      projectId: "my-app",
      status: "failed",
      error: {
        code: "action.failed",
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
          code: "action.failed",
          message: "Slack timed out",
          phase: "effects",
        },
      },
    })
    const page = await storage.actionRuns.list({
      projectId: "my-app",
      actionId: "createInvoice",
      limit: 10,
    })
    expect(page.runs).toHaveLength(1)
  })

  test("serializes ontology materialization before terminal Action completion", async () => {
    await queueRunningAction(storage, "act_materializing")
    const locked = deferred<void>()
    const release = deferred<void>()
    const materialization = storage.transaction(async (tx) => {
      if (!tx.actionRuns) throw new Error("missing fence")
      await tx.actionRuns.lockForMaterialization({
        projectId: "my-app",
        actionId: "createInvoice",
        runId: "act_materializing",
      })
      locked.resolve()
      await release.promise
    })
    await locked.promise

    let completionSettled = false
    const completion = storage
      .transaction(async (tx) => {
        if (!tx.actionRuns) throw new Error("missing Action storage")
        await tx.actionRuns.finish({
          projectId: "my-app",
          id: "act_materializing",
          status: "succeeded",
        })
      })
      .finally(() => {
        completionSettled = true
      })
    await Bun.sleep(20)
    expect(completionSettled).toBe(false)

    release.resolve()
    await materialization
    await completion
    expect(
      await storage.actionRuns.getById({ projectId: "my-app", id: "act_materializing" })
    ).toMatchObject({ status: "succeeded" })
  })

  test("rejects ontology materialization after terminal Action completion wins the row lock", async () => {
    await queueRunningAction(storage, "act_finishing")
    const updated = deferred<void>()
    const release = deferred<void>()
    const completion = storage.transaction(async (tx) => {
      if (!tx.actionRuns) throw new Error("missing Action storage")
      await tx.actionRuns.finish({
        projectId: "my-app",
        id: "act_finishing",
        status: "succeeded",
      })
      updated.resolve()
      await release.promise
    })
    await updated.promise

    let fenceSettled = false
    const fence = storage
      .transaction(async (tx) => {
        if (!tx.actionRuns) throw new Error("missing fence")
        await tx.actionRuns.lockForMaterialization({
          projectId: "my-app",
          actionId: "createInvoice",
          runId: "act_finishing",
        })
      })
      .then(
        () => null,
        (error: unknown) => error
      )
      .finally(() => {
        fenceSettled = true
      })
    await Bun.sleep(20)
    expect(fenceSettled).toBe(false)

    release.resolve()
    await completion
    const error = await fence
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("status 'succeeded'")
  })
})

async function queueRunningAction(storage: PostgresStorage, id: string): Promise<void> {
  await storage.actionRuns.queue({
    id,
    projectId: "my-app",
    actionId: "createInvoice",
    subject: { kind: "none" },
    params: {},
    idempotencyKey: `action:my-app:${id}`,
  })
  await storage.actionRuns.start({ id, projectId: "my-app" })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
