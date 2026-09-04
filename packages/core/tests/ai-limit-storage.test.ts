import { expect, test } from "bun:test"
import { InMemoryAiLimitStorage } from "../src/storage/ai-limits"
import { InMemoryStorage } from "../src/storage/in-memory"
import { runAiLimitStorageContractSuite } from "../src/testing/ai-limit-storage-contract"

runAiLimitStorageContractSuite("InMemoryAiLimitStorage", {
  createStorage: () => new InMemoryStorage(),
})

test("standalone in-memory limits fail closed without an immutable accounting source", async () => {
  const limits = new InMemoryAiLimitStorage({ executionExists: () => true })
  await limits.createPolicy({
    id: "tokens",
    projectId: "project",
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 10 },
  })

  await expect(
    limits.reserveModelCall({
      projectId: "project",
      executionId: "execution",
      attempt: 1,
      callId: "call",
      subjects: [],
      estimates: [{ meter: "tokens.total", amount: 1 }],
      reservedAt: new Date("2026-08-15T00:00:00.000Z"),
    })
  ).resolves.toMatchObject({
    status: "unavailable",
    reasons: ["incompleteAccounting"],
  })
})

test("initialized period counters avoid repeated immutable-ledger scans", async () => {
  let scans = 0
  const limits = new InMemoryAiLimitStorage({
    executionExists: () => true,
    listUsageRecords: () => {
      scans += 1
      return []
    },
  })
  await limits.createPolicy({
    id: "tokens",
    projectId: "project",
    subject: { type: "project" },
    limit: { meter: "tokens.total", amount: 10 },
  })

  await limits.listPolicyStatuses({ projectId: "project", at: new Date("2026-08-15Z") })
  await limits.listPolicyStatuses({ projectId: "project", at: new Date("2026-08-20Z") })
  await limits.reserveModelCall({
    projectId: "project",
    executionId: "execution",
    attempt: 1,
    callId: "call",
    subjects: [],
    estimates: [{ meter: "tokens.total", amount: 1 }],
    reservedAt: new Date("2026-08-21Z"),
  })

  expect(scans).toBe(1)
})
