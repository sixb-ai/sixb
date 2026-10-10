import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ActionRunError } from "@sixb/core/storage"
import { createTestActionRunRecord, runActionRunStorageContractSuite } from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import { createTestStorage } from "./helpers"

runActionRunStorageContractSuite("PostgresStorage Action runs", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})

describe("PgActionRunStorage", () => {
  let storage: PostgresStorage

  beforeEach(async () => {
    ;({ storage } = await createTestStorage())
  })

  afterEach(async () => {
    await storage.dropSchema()
    await storage.close()
  })

  // Two processes can execute the same run id; the one that records it second must get a refusal
  // it can answer with the first one's record, not a raised unique violation.
  test("makes a concurrent record of the same run wait for the first, then refuses it", async () => {
    const run = await createTestActionRunRecord(storage.executions, {
      id: "act_concurrent",
      projectId: "my-app",
      actionId: "createInvoice",
      subject: { kind: "none" },
      params: {},
      idempotencyKey: "action:my-app:act_concurrent",
    })
    const recorded = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = storage.transaction(async (tx) => {
      if (!tx.actionRuns) throw new Error("missing Action run storage")
      await tx.actionRuns.record(run)
      recorded.resolve()
      await release.promise
    })
    await recorded.promise

    let secondSettled = false
    const second = storage.actionRuns
      .record(run)
      .then(
        () => null,
        (error: unknown) => error
      )
      .finally(() => {
        secondSettled = true
      })
    await Bun.sleep(20)
    expect(secondSettled).toBe(false)

    release.resolve()
    await first
    const refusal = await second
    expect(refusal).toBeInstanceOf(ActionRunError)
    expect(refusal instanceof Error ? refusal.message : refusal).toContain(
      "Action run 'act_concurrent' is already recorded for project 'my-app'."
    )
  })
})
