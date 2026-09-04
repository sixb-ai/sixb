import type { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { AiCostStorage } from "@sixb/core/storage"
import {
  createTestAgentExecution,
  createTestWorkflowExecution,
  runAiCostStorageContractSuite,
  runAiModelCallGroupsContractSuite,
  seedAiCostStorageContractUsage,
} from "@sixb/core/testing"
import { SqliteStorage } from "../src"

runAiModelCallGroupsContractSuite("SQLite model-call groups", {
  createStorage: () => new SqliteStorage(),
  cleanup: (storage) => storage.close(),
})

const bundles = new Map<AiCostStorage, SqliteStorage>()
runAiCostStorageContractSuite("SqliteAiCostStorage", {
  createStorage: () => {
    const bundle = new SqliteStorage()
    bundles.set(bundle.aiCosts, bundle)
    return bundle.aiCosts
  },
  setup: async (costs) => {
    const bundle = bundles.get(costs)
    if (!bundle) throw new Error("Expected SQLite storage bundle")
    await seedAiCostStorageContractUsage(bundle.executions, bundle.aiUsage)
  },
  cleanup: (costs) => {
    bundles.get(costs)?.close()
    bundles.delete(costs)
  },
})

describe("SqliteStorage AI accounting", () => {
  test("deserializes only the requested model-call page", async () => {
    const storage = new SqliteStorage()
    try {
      await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
      const db = (storage as unknown as { connection: { db: Database } }).connection.db
      db.query(
        `INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id,
          currency, amount_nanos, reason, details, rated_at
        ) VALUES (
          'cost-contract-project', 'usage_2', 'unpriceable', 'vercel', 'unpriced/model',
          NULL, NULL, 'missingCatalogEntry', '{}', '2026-08-01T12:00:00.200Z'
        )`
      ).run()

      // The malformed-but-valid JSON details are outside this one-row page. A full-range reader
      // attempts to deserialize them and fails; SQL pagination never selects that row.
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
      storage.close()
    }
  })

  test("aggregates SQLite money above the signed 64-bit sum range exactly", async () => {
    const storage = new SqliteStorage()
    try {
      await seedAiCostStorageContractUsage(storage.executions, storage.aiUsage)
      const db = (storage as unknown as { connection: { db: Database } }).connection.db
      const insert = db.query(
        `INSERT INTO ai_model_call_valuations (
          project_id, usage_record_id, status, provider_id, model_id,
          currency, amount_nanos, reason, details, rated_at
        ) VALUES (
          'cost-contract-project', ?, 'rated', 'gateway', 'test-model',
          'USD', ?, NULL, '{}', '2026-08-01T12:00:00.200Z'
        )`
      )
      insert.run("usage_1", 9_223_372_036_854_775_807n)
      insert.run("usage_2", 9_223_372_036_854_775_807n)

      const overview = await storage.aiCosts.queryProjectOverview({
        projectId: "cost-contract-project",
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-02T00:00:00.000Z"),
        bucket: "day",
      })
      expect(overview.totals.costs.amounts).toEqual([
        { currency: "USD", amountNanos: "18446744073709551614" },
      ])
      const groups = await storage.aiCosts.listModelCallGroups({
        projectId: "cost-contract-project",
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-02T00:00:00.000Z"),
      })
      expect(groups.items[0]?.costs.amounts).toEqual(overview.totals.costs.amounts)
    } finally {
      storage.close()
    }
  })

  test("returns workflow-agent attribution with model-call pages", async () => {
    const storage = new SqliteStorage()
    try {
      const workflowRunId = "workflow_run_1"
      const workflowId = "research-workflow"
      const nodeRunId = `${workflowRunId}:node:0`
      const workflowExecutionId = await createTestWorkflowExecution(storage.executions, {
        projectId: "project_1",
        workflowId,
        runId: workflowRunId,
      })
      await storage.workflowRuns.queue({
        id: workflowRunId,
        projectId: "project_1",
        executionId: workflowExecutionId,
        workflowId,
        input: {},
        requesterGroupIds: [],
      })
      await storage.workflowRuns.start({ id: workflowRunId, projectId: "project_1" })
      await storage.workflowRuns.nodes.start({
        id: nodeRunId,
        projectId: "project_1",
        workflowRunId,
        workflowId,
        nodeIndex: 0,
        nodeType: "agent",
        nodeId: "research-step",
        nodeKey: "researchStep",
        input: {},
      })
      const executionId = await createTestAgentExecution(storage, {
        projectId: "project_1",
        agentId: "research",
        runId: nodeRunId,
        sourceExecutionId: workflowExecutionId,
      })
      await storage.workflowRuns.agentNodes.create({
        projectId: "project_1",
        nodeRunId,
        executionId,
        agentId: "research",
        prompt: "Research the incident.",
      })
      await storage.aiUsage.recordModelCall({
        id: "usage_workflow_agent_1",
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
        storage.aiCosts.listModelCallGroups({
          projectId: "project_1",
          from: new Date("2026-09-01T00:00:00.000Z"),
          to: new Date("2026-09-02T00:00:00.000Z"),
        })
      ).resolves.toMatchObject({
        total: 1,
        items: [
          {
            executionId,
            attribution: { kind: "workflowAgent", workflowId, workflowRunId, nodeRunId },
            modelCallCount: 1,
            executions: [{ executionId, modelCallCount: 1 }],
          },
        ],
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
              kind: "workflowAgent",
              agentId: "research",
              nodeRunId,
              workflowId,
              workflowRunId,
            },
          },
        ],
      })
    } finally {
      storage.close()
    }
  })

  test("returns child-agent attribution with model-call pages", async () => {
    const storage = new SqliteStorage()
    try {
      const parentRunId = "parent_run_1"
      const childRunId = "child_run_1"
      await storage.agents.threads.create({
        id: "thread_1",
        projectId: "project_1",
        agentId: "main",
        ownerPrincipal: { type: "user", id: "user_1" },
      })
      const parentExecutionId = await createTestAgentExecution(storage, {
        projectId: "project_1",
        agentId: "main",
        runId: parentRunId,
        authority: "inherited",
      })
      await storage.agents.runs.create({
        id: parentRunId,
        projectId: "project_1",
        executionId: parentExecutionId,
        threadId: "thread_1",
        agentId: "main",
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
        agentId: "child",
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
      storage.close()
    }
  })

  test("attributes catalog valuations to durable agent executions", async () => {
    const storage = new SqliteStorage()
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
        spec: { model: { provider: "test", modelId: "test-model" } },
        requesterGroupIds: [],
      })
      await storage.transaction(async (tx) => {
        const usage = await tx.aiUsage!.recordModelCall({
          id: "usage_agent_1",
          projectId: "project_1",
          executionId,
          attempt: 1,
          callId: "call_1",
          requesterGroupIds: [],
          providerId: "anthropic.messages",
          requestedModelId: "claude-opus-4-8",
          responseId: "response_1",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            uncachedInputTokens: 10,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
          },
          occurredAt: new Date("2026-09-01T12:00:00.000Z"),
        })
        await tx.aiCosts!.recordModelCallCost({
          projectId: "project_1",
          usageRecordId: usage.record.id,
          status: "rated",
          billingIdentity: { providerId: "test-provider", modelId: "test-model" },
          pricingContext: {},
          priceSource: {
            sourceId: "test-catalog",
            sourceEntryId: "test-provider/test-model",
            sourceVersion: "test-catalog-v1",
            sourceUrl: "https://example.test/ai-pricing.json",
            observedAt: new Date("2026-09-01T12:00:00.000Z"),
          },
          money: { currency: "USD", amountNanos: "15" },
          components: [
            {
              meter: "tokens.input.total",
              quantity: "10",
              rateAmountNanosPerMillion: "1000000",
              chargeAmountNanos: "10",
            },
            {
              meter: "tokens.output.total",
              quantity: "5",
              rateAmountNanosPerMillion: "1000000",
              chargeAmountNanos: "5",
            },
          ],
          ratedAt: new Date("2026-09-01T12:00:00.200Z"),
        })
      })

      await expect(
        storage.aiCosts.queryProjectOverview({
          projectId: "project_1",
          from: new Date("2026-09-01T00:00:00.000Z"),
          to: new Date("2026-09-02T00:00:00.000Z"),
          bucket: "day",
        })
      ).resolves.toMatchObject({
        totals: {
          modelCallCount: 1,
          costs: { ratedCallCount: 1, unpriceableCallCount: 0 },
        },
        agents: [{ agentId: "research", modelCallCount: 1 }],
        workflows: [],
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
      storage.close()
    }
  })
})
