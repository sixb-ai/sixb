import { expect, test } from "bun:test"
import type { AiCostStorage } from "@sixb/core/storage"
import {
  createTestAgentExecution,
  runAiCostStorageContractSuite,
  runAiModelCallGroupsContractSuite,
  seedAiCostStorageContractUsage,
} from "@sixb/core/testing"
import type { PostgresStorage } from "../src"
import type { PgStoreClient } from "../src/transactions"
import { createTestStorage } from "./helpers"

runAiModelCallGroupsContractSuite("PostgreSQL model-call groups", {
  createStorage: async () => (await createTestStorage()).storage,
  cleanup: async (storage) => {
    await storage.dropSchema()
    await storage.close()
  },
})

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
      ownerPrincipal: { type: "user", id: "user_1" },
    })
    const executionId = await createTestAgentExecution(
      { auth: storage.auth, executions: storage.executions },
      { projectId: "project_1", runId: "run_1", authority: "inherited" }
    )
    await storage.agents.runs.create({
      id: "run_1",
      projectId: "project_1",
      executionId,
      threadId: "thread_1",
      triggerMessageId: "message_1",
      spec: { model: { provider: "test", modelId: "test-model" } },
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

test("PgAiCostStorage returns child-agent attribution with each model-call page", async () => {
  const { storage } = await createTestStorage()
  try {
    const parentRunId = "parent_run_1"
    const childRunId = "child_run_1"
    await storage.agents.threads.create({
      id: "thread_1",
      projectId: "project_1",
      ownerPrincipal: { type: "user", id: "user_1" },
    })
    const parentExecutionId = await createTestAgentExecution(storage, {
      projectId: "project_1",
      runId: parentRunId,
      authority: "inherited",
    })
    await storage.agents.runs.create({
      id: parentRunId,
      projectId: "project_1",
      executionId: parentExecutionId,
      threadId: "thread_1",
      triggerMessageId: "message_1",
      spec: { model: { provider: "test", modelId: "test-model" } },
      requesterGroupIds: ["users"],
    })
    await storage.agents.runs.start({
      id: parentRunId,
      projectId: "project_1",
      execution: {
        token: "parent-token",
        queueLeaseExpiresAt: new Date("2100-01-01T00:00:00.000Z"),
      },
    })
    const childExecutionId = await createTestAgentExecution(storage, {
      projectId: "project_1",
      actorId: "child",
      runId: childRunId,
      sourceExecutionId: parentExecutionId,
      authority: "inherited",
    })
    await storage.agents.runs.createSubagent({
      id: childRunId,
      projectId: "project_1",
      executionId: childExecutionId,
      parentRunId,
      parentExecutionToken: "parent-token",
      spawnKey: "research",
      spec: {
        model: { provider: "anthropic.messages", modelId: "claude-opus-4-8" },
        task: "Research the incident.",
        toolNames: [],
        maxSteps: 25,
      },
      maxActiveChildren: 4,
    })
    await storage.aiUsage.recordModelCall({
      id: "usage_child_agent_1",
      projectId: "project_1",
      executionId: childExecutionId,
      attempt: 1,
      callId: "call_1",
      requesterGroupIds: ["users"],
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
            kind: "subagent",
            subagentRunId: childRunId,
            parentRunId,
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
