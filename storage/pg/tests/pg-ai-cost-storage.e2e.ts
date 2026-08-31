import { expect, test } from "bun:test"
import type { AiCostStorage } from "@sixb/core/storage"
import {
  createTestAgentExecution,
  runAiCostStorageContractSuite,
  seedAiCostStorageContractUsage,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage } from "./helpers"

const bundles = new Map<AiCostStorage, PostgresStorage>()
test("PgAiCostStorage deserializes only the requested model-call page", async () => {
  const { storage } = await createTestStorage()
  try {
    await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
    const sql = (storage as unknown as { sql: PgStoreClient }).sql
    await sql`
      INSERT INTO ai_model_call_valuations (
        project_id, usage_record_id, status, provider_id, model_id,
        currency, amount_nanos, reason, details, rated_at
      ) VALUES (
        'cost-contract-project', 'usage_2', 'unpriceable', 'vercel', 'unpriced/model',
        NULL, NULL, 'missingCatalogEntry', '{}'::jsonb, '2026-08-01T12:00:00.200Z'
      )
    `

    await expect(
      storage.aiCosts.listModelCalls({
        projectId: "cost-contract-project",
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-02T00:00:00.000Z"),
        limit: 1,
      })
    ).resolves.toMatchObject({
      total: 3,
      hasMore: true,
      items: [{ usage: { id: "usage_1" } }],
    })
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
})

test("PgAiCostStorage returns direct agent attribution with each model-call page", async () => {
  const { storage } = await createTestStorage()
  try {
    await storage.agents.threads.create({
      id: "thread_1",
      projectId: "project_1",
      agentId: "research",
      ownerPrincipal: { type: "user", id: "user_1" },
    })
    const executionId = await createTestAgentExecution(
      { auth: storage.auth, executions: storage.executions },
      { projectId: "project_1", agentId: "research", runId: "run_1" }
    )
    await storage.agents.runs.create({
      id: "run_1",
      projectId: "project_1",
      executionId,
      threadId: "thread_1",
      agentId: "research",
      triggerMessageId: "message_1",
      requesterGroupIds: [],
    })
    await storage.aiUsage.recordModelCall({
      id: "usage_1",
      projectId: "project_1",
      executionId,
      attempt: 1,
      callId: "call_1",
      requesterGroupIds: [],
      providerId: "anthropic.messages",
      requestedModelId: "claude-opus-4-8",
      responseId: "response_1",
      usage: { inputTokens: 10, outputTokens: 5 },
      occurredAt: new Date("2026-09-01T12:00:00.000Z"),
    })

    await expect(
      storage.aiCosts.listModelCalls({
        projectId: "project_1",
        from: new Date("2026-09-01T00:00:00.000Z"),
        to: new Date("2026-09-02T00:00:00.000Z"),
      })
    ).resolves.toMatchObject({
      items: [
        {
          attribution: {
            kind: "agent",
            agentId: "research",
            agentRunId: "run_1",
            threadId: "thread_1",
          },
        },
      ],
    })
  } finally {
    await storage.dropSchema()
    await storage.close()
  }
})

runAiCostStorageContractSuite("PgAiCostStorage", {
  createStorage: async () => {
    const { storage } = await createTestStorage()
    bundles.set(storage.aiCosts, storage)
    return storage.aiCosts
  },
  setup: async (costs) => {
    const storage = bundles.get(costs)
    if (!storage) throw new Error("Expected PostgreSQL storage bundle")
    await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
  },
  cleanup: async (costs) => {
    const storage = bundles.get(costs)
    if (!storage) return
    bundles.delete(costs)
    await storage.dropSchema()
    await storage.close()
  },
})
