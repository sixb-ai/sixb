import { describe, expect, test } from "bun:test"
import type { Storage } from "../storage/types"
import { workflowAgentStepActorId } from "../workflows/agent-step-identity"
import { createTestAgentExecution } from "./agent-execution"
import type { AiStorageContractSuiteOptions } from "./ai-cost-storage-contract"
import { createTestWorkflowExecution } from "./workflow-execution"

export type AiModelCallGroupsContractStorage = Required<
  Pick<Storage, "agents" | "aiUsage" | "aiCosts" | "executions" | "workflowRuns">
>

const projectId = "model-call-groups"
const range = {
  projectId,
  from: new Date("2026-09-01T00:00:00Z"),
  to: new Date("2026-09-02T00:00:00Z"),
}

/** Regression: grouping the raw-call page instead of the full filtered set breaks these totals. */
export function runAiModelCallGroupsContractSuite<T extends AiModelCallGroupsContractStorage>(
  name: string,
  options: AiStorageContractSuiteOptions<T>
): void {
  describe(name, () => {
    test("attributes workflow usage to step references and keeps same-named steps separate", async () => {
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        for (const [index, workflowId] of ["billing", "billing", "shipping"].entries()) {
          await seedWorkflowCall(storage, workflowId, `workflow-run-${index}`)
        }
        const overview = await storage.aiCosts.queryProjectOverview({ ...range, bucket: "day" })
        // Regression proof: grouping only by step id merges billing and shipping; exposing
        // the actor id instead of the step references fails these exact projections.
        expect(
          overview.agents.map((entry) => ({
            kind: entry.kind,
            modelCallCount: entry.modelCallCount,
            ...(entry.kind === "workflowAgent"
              ? { workflowId: entry.workflowId, agentStepId: entry.agentStepId }
              : {}),
          }))
        ).toEqual([
          {
            kind: "workflowAgent",
            workflowId: "billing",
            agentStepId: "review",
            modelCallCount: 2,
          },
          {
            kind: "workflowAgent",
            workflowId: "shipping",
            agentStepId: "review",
            modelCallCount: 1,
          },
        ])
        expect(overview.totals.costs.amounts).toEqual([{ currency: "USD", amountNanos: "30" }])
        const calls = await storage.aiCosts.listModelCalls(range)
        const groups = await storage.aiCosts.listModelCallGroups(range)
        expect(calls.total).toBe(3)
        expect(groups.total).toBe(3)
        for (const call of calls.items) {
          const runId = call.usage.callId
          const workflowId = runId === "workflow-run-2" ? "shipping" : "billing"
          const attribution = {
            kind: "workflowAgent" as const,
            workflowId,
            agentStepId: "review",
            workflowRunId: runId,
            nodeRunId: `${runId}:node:0`,
          }
          expect(call.attribution).toEqual(attribution)
          const group = groups.items.find((item) => item.executionId === call.usage.executionId)
          expect(group?.attribution).toEqual(attribution)
          expect(group?.executions[0]?.attribution).toEqual(attribution)
        }
      } finally {
        await options.cleanup?.(storage)
      }
    })

    test("paginates whole runs, keeps filtered parents, and preserves exact accounting", async () => {
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        await seed(storage)
        const first = await storage.aiCosts.listModelCallGroups({ ...range, limit: 1 })
        expect(first).toMatchObject({
          total: 2,
          hasMore: true,
          items: [{ executionId: "exec_second", modelCallCount: 1 }],
        })
        const second = await storage.aiCosts.listModelCallGroups({ ...range, limit: 1, offset: 1 })
        expect(second).toMatchObject({
          total: 2,
          hasMore: false,
          items: [
            {
              executionId: "exec_parent",
              modelCallCount: 32,
              attribution: { kind: "agent", agentRunId: "parent", threadId: "thread" },
              costs: {
                amounts: [
                  { currency: "EUR", amountNanos: "0" },
                  { currency: "USD", amountNanos: "300" },
                ],
                reportedCallCount: 31,
                unvaluedCallCount: 1,
              },
              executions: [
                { executionId: "exec_parent", modelCallCount: 1, totalTokens: 3 },
                {
                  executionId: "exec_child",
                  modelCallCount: 31,
                  attribution: { kind: "subagent", parentRunId: "parent", subagentRunId: "child" },
                },
              ],
            },
          ],
        })
        expect(second.items[0]?.totalTokens).toBeUndefined()
        const filtered = await storage.aiCosts.listModelCallGroups({
          ...range,
          providerId: "child-provider",
          modelId: "small",
          valuationStatus: "reported",
        })
        expect(filtered).toMatchObject({
          total: 1,
          items: [
            {
              executionId: "exec_parent",
              modelCallCount: 30,
              totalTokens: 90,
              costs: {
                amounts: [{ currency: "USD", amountNanos: "300" }],
                reportedCallCount: 30,
                unvaluedCallCount: 0,
              },
              executions: [{ executionId: "exec_child", modelCallCount: 30 }],
            },
          ],
        })
        expect(filtered.items[0]?.executions).toHaveLength(1)
        const late = await storage.aiCosts.listModelCallGroups({
          ...range,
          from: new Date("2026-09-01T12:00:01Z"),
          to: new Date("2026-09-01T12:00:32Z"),
        })
        expect(late).toMatchObject({
          total: 1,
          items: [{ executionId: "exec_parent", modelCallCount: 31 }],
        })
        const unknown = await storage.aiCosts.listModelCallGroups({
          ...range,
          valuationStatus: "unvalued",
          modelId: "small",
        })
        expect(unknown.items[0]?.costs.amounts).toEqual([])
        expect(unknown.items[0]?.totalTokens).toBeUndefined()
        expect(
          await storage.aiCosts.listModelCallGroups({ ...range, projectId: "other-project" })
        ).toEqual({ items: [], total: 0, hasMore: false })
        expect(await storage.aiCosts.listModelCallGroups({ ...range, offset: 20 })).toEqual({
          items: [],
          total: 2,
          hasMore: false,
        })
        await expect(
          storage.aiCosts.listModelCallGroups({ ...range, limit: 201 })
        ).rejects.toThrow()
        await expect(
          storage.aiCosts.listModelCallGroups({ ...range, to: range.from })
        ).rejects.toThrow()
      } finally {
        await options.cleanup?.(storage)
      }
    })
  })
}

async function seedWorkflowCall(
  storage: AiModelCallGroupsContractStorage,
  workflowId: string,
  runId: string
) {
  const sourceExecutionId = await createTestWorkflowExecution(storage.executions, {
    projectId,
    workflowId,
    runId,
  })
  await storage.workflowRuns.queue({
    projectId,
    id: runId,
    workflowId,
    executionId: sourceExecutionId,
    input: {},
    requesterGroupIds: [],
  })
  await storage.workflowRuns.start({ projectId, id: runId })
  const nodeRunId = `${runId}:node:0`
  await storage.workflowRuns.nodes.start({
    projectId,
    id: nodeRunId,
    workflowId,
    workflowRunId: runId,
    nodeIndex: 0,
    nodeType: "agent",
    nodeId: "review",
    nodeKey: "review",
    input: {},
  })
  const actorId = workflowAgentStepActorId(workflowId, "review")
  const executionId = await createTestAgentExecution(storage, {
    projectId,
    runId: nodeRunId,
    actorId,
    sourceExecutionId,
  })
  await storage.workflowRuns.agentNodes.create({
    projectId,
    nodeRunId,
    executionId,
    actorId,
    prompt: "Review the task.",
  })
  const { record } = await storage.aiUsage.recordModelCall({
    projectId,
    id: `usage:${runId}`,
    executionId,
    attempt: 1,
    callId: runId,
    requesterGroupIds: [],
    providerId: "test",
    requestedModelId: "small",
    responseId: runId,
    usage: { inputTokens: 10, outputTokens: 5 },
    occurredAt: new Date("2026-09-01T12:00:00Z"),
  })
  await storage.aiCosts.recordModelCallCost({
    projectId,
    usageRecordId: record.id,
    status: "reported",
    pricingContext: {},
    reportSource: { providerId: "test", responseId: runId },
    billingIdentity: { providerId: "test", modelId: "small" },
    money: { currency: "USD", amountNanos: "10" },
    ratedAt: new Date("2026-09-01T12:00:00Z"),
  })
}

async function seed(storage: AiModelCallGroupsContractStorage) {
  await storage.agents.threads.create({
    id: "thread",
    projectId,
    ownerPrincipal: { type: "user", id: "user" },
  })
  for (const runId of ["parent", "second"]) {
    const executionId = await createTestAgentExecution(storage, {
      projectId,
      runId,
      executionId: `exec_${runId}`,
      authority: "inherited",
    })
    await storage.agents.runs.create({
      id: runId,
      projectId,
      executionId,
      threadId: "thread",
      triggerMessageId: `message_${runId}`,
      spec: { model: { provider: "parent-provider", modelId: "large" } },
      requesterGroupIds: [],
    })
    await storage.agents.runs.start({
      id: runId,
      projectId,
      execution: { token: runId, queueLeaseExpiresAt: new Date("2100-01-01T00:00:00Z") },
    })
    if (runId === "parent") {
      const childExecution = await createTestAgentExecution(storage, {
        projectId,
        actorId: "child",
        runId: "child",
        executionId: "exec_child",
        sourceExecutionId: executionId,
        authority: "inherited",
      })
      await storage.agents.runs.createSubagent({
        id: "child",
        projectId,
        executionId: childExecution,
        parentRunId: runId,
        parentExecutionToken: runId,
        spawnKey: "research",
        spec: {
          model: { provider: "child-provider", modelId: "small" },
          task: "Research",
          toolNames: [],
          maxSteps: 25,
        },
        maxActiveChildren: 4,
      })
    }
    await storage.agents.runs.finish({
      id: runId,
      projectId,
      executionToken: runId,
      status: "succeeded",
    })
  }
  for (let index = 0; index < 33; index++) {
    const child = index > 0 && index < 32
    const result = await storage.aiUsage.recordModelCall({
      id: `usage_${index}`,
      projectId,
      executionId: index === 0 ? "exec_parent" : child ? "exec_child" : "exec_second",
      attempt: 1,
      callId: `call_${index}`,
      requesterGroupIds: [],
      providerId: child ? "child-provider" : "parent-provider",
      requestedModelId: child ? "small" : "large",
      responseId: `response_${index}`,
      usage: index === 31 ? {} : { inputTokens: 1, outputTokens: 2 },
      occurredAt: new Date(Date.parse("2026-09-01T12:00:00Z") + index * 1000),
    })
    if (index >= 31) continue
    await storage.aiCosts.recordModelCallCost({
      projectId,
      usageRecordId: result.record.id,
      status: "reported",
      billingIdentity: {
        providerId: child ? "child-provider" : "parent-provider",
        modelId: child ? "small" : "large",
      },
      pricingContext: {},
      reportSource: {
        providerId: child ? "child-provider" : "parent-provider",
        responseId: `cost_${index}`,
      },
      money: { currency: index === 0 ? "EUR" : "USD", amountNanos: index === 0 ? "0" : "10" },
      ratedAt: new Date("2026-09-01T12:05:00Z"),
    })
  }
}
