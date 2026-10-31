import { describe, expect, test } from "bun:test"
import type { Storage } from "../storage/types"
import { workflowAgentStepActorId } from "../workflows/agent-step-identity"
import { createTestAgentExecution } from "./agent-execution"
import type { AiStorageContractSuiteOptions } from "./ai-cost-storage-contract"
import { createTestWorkflowExecution } from "./workflow-execution"

export type AiModelCallGroupsContractStorage = Required<
  Pick<Storage, "agents" | "aiUsage" | "aiCosts" | "auth" | "executions" | "workflowRuns">
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
    test("attributes direct calls and retries to requests, actions, and workflows", async () => {
      // Removal proof: return undefined from directModelCallAttribution and run this suite.
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        const expected = [
          { kind: "request", requestId: "request" },
          { kind: "action", actionId: "summarize", actionRunId: "action" },
          { kind: "workflow", workflowId: "summarize", workflowRunId: "workflow" },
        ] as const
        for (const attribution of expected) {
          const kind = attribution.kind
          const primitive = {
            kind: kind === "action" ? ("action" as const) : ("workflow" as const),
            id: "summarize",
            runId: kind,
          }
          const execution = await storage.executions.create({
            projectId,
            id: kind,
            executor:
              kind === "request"
                ? { type: "request", requestId: kind }
                : { type: "primitive", kind, runId: kind },
            source:
              kind === "request"
                ? { type: "http", requestId: kind }
                : { type: "event", eventId: kind },
            correlationId: kind,
            authorizationRef:
              kind === "request" ? { type: "disabled" } : { type: "trustedPrimitive", primitive },
          })
          for (const attempt of [1, 2]) {
            await storage.aiUsage.recordModelCall({
              projectId,
              id: `${kind}:${attempt}`,
              executionId: execution.id,
              attempt,
              callId: `${kind}:${attempt}`,
              requesterGroupIds: execution.requesterGroupIds,
              providerId: "test",
              requestedModelId: "small",
              responseId: `${kind}:${attempt}`,
              usage: { inputTokens: 2, outputTokens: 3 },
              occurredAt: new Date("2026-09-01T12:00:00Z"),
            })
          }
          const calls = await storage.aiCosts.listModelCalls({
            ...range,
            executionId: execution.id,
          })
          expect(calls.total).toBe(2)
          expect(calls.items.map((call) => call.attribution)).toEqual([attribution, attribution])
        }
        const groups = await storage.aiCosts.listModelCallGroups(range)
        expect(groups.total).toBe(3)
        for (const attribution of expected) {
          const group = groups.items.find((item) => item.executionId === attribution.kind)
          expect(group).toMatchObject({
            attribution,
            modelCallCount: 2,
            totalTokens: 10,
            executions: [{ attribution, modelCallCount: 2 }],
          })
        }
        const overview = await storage.aiCosts.queryProjectOverview({ ...range, bucket: "day" })
        expect(overview.totals.modelCallCount).toBe(6)
        expect(overview.agents).toEqual([])
        expect(overview.workflows).toMatchObject([{ workflowId: "summarize", modelCallCount: 2 }])
      } finally {
        await options.cleanup?.(storage)
      }
    })

    // Removal proof: drop tokenless_count from a storage's group query (or tokenlessCount from
    // summarize); the mixed run then hides its token total behind the image call.
    // Removal proof: drop the `person` or `modelSeries` dimension from a storage's overview, or
    // one condition of its kind, source or requester filter; this test then fails on that part.
    test("breaks spend down by who asked and by model per period, and narrows to either", async () => {
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        const twoDays = { ...range, to: new Date("2026-09-03T00:00:00Z") }
        await storage.auth.users.create({ projectId, id: "usr_ava", email: "ava@example.com" })
        await storage.auth.users.create({ projectId, id: "usr_ben", email: "ben@example.com" })
        await storage.auth.serviceAccounts.create({ projectId, id: "svc_bot", name: "Bot" })
        // A workflow and two actions someone asked for, and a request nobody did.
        const runs = [
          {
            id: "ava",
            kind: "workflow",
            by: { type: "user", id: "usr_ava" },
            model: "large",
            day: "01",
          },
          {
            id: "ben",
            kind: "action",
            by: { type: "user", id: "usr_ben" },
            model: "small",
            day: "02",
          },
          {
            id: "bot",
            kind: "action",
            by: { type: "serviceAccount", id: "svc_bot" },
            model: "embed",
            day: "02",
          },
          { id: "req", kind: "request", model: "small", day: "02" },
        ] as const
        for (const run of runs) {
          const execution = await storage.executions.create({
            projectId,
            id: run.id,
            ...("by" in run ? { requestedBy: run.by } : {}),
            ...(run.kind === "request"
              ? {
                  executor: { type: "request", requestId: run.id },
                  source: { type: "http", requestId: run.id },
                  authorizationRef: { type: "disabled" },
                }
              : {
                  executor: { type: "primitive", kind: run.kind, runId: run.id },
                  source: { type: "event", eventId: run.id },
                  authorizationRef: {
                    type: "trustedPrimitive",
                    primitive: { kind: run.kind, id: "close", runId: run.id },
                  },
                }),
            correlationId: run.id,
          })
          await storage.aiUsage.recordModelCall({
            projectId,
            id: run.id,
            executionId: execution.id,
            attempt: 1,
            callId: run.id,
            requesterGroupIds: [],
            providerId: "test",
            requestedModelId: run.model,
            modelKind: run.model === "embed" ? "embedding" : "language",
            responseId: run.id,
            usage: { inputTokens: 2, outputTokens: 3 },
            occurredAt: new Date(`2026-09-${run.day}T12:00:00Z`),
          })
        }

        const overview = await storage.aiCosts.queryProjectOverview({ ...twoDays, bucket: "day" })
        const people = overview.people
          .map((entry) => `${entry.requester?.id ?? "nobody"}:${entry.modelCallCount}`)
          .sort()
        expect(people).toEqual(["nobody:1", "svc_bot:1", "usr_ava:1", "usr_ben:1"])
        const perDay = Object.fromEntries(
          overview.modelSeries.map((entry) => [
            entry.modelId,
            entry.series.map((bucket) => bucket.modelCallCount),
          ])
        )
        expect(perDay).toEqual({ large: [1, 0], small: [0, 2], embed: [0, 1] })

        const count = async (
          filters: Partial<Parameters<typeof storage.aiCosts.listModelCalls>[0]>
        ) => {
          const [calls, groups, totals] = await Promise.all([
            storage.aiCosts.listModelCalls({ ...twoDays, ...filters }),
            storage.aiCosts.listModelCallGroups({ ...twoDays, ...filters }),
            storage.aiCosts.queryProjectOverview({ ...twoDays, ...filters, bucket: "day" }),
          ])
          // The three reads narrow alike.
          expect(groups.total).toBe(calls.total)
          expect(totals.totals.modelCallCount).toBe(calls.total)
          return calls.total
        }
        expect(await count({ requester: { type: "user", id: "usr_ava" } })).toBe(1)
        expect(await count({ requester: { type: "serviceAccount", id: "svc_bot" } })).toBe(1)
        expect(await count({ requester: "none" })).toBe(1)
        expect(await count({ source: { kind: "action" } })).toBe(2)
        expect(await count({ source: { kind: "workflow", workflowId: "close" } })).toBe(1)
        expect(await count({ source: { kind: "workflow", workflowId: "other" } })).toBe(0)
        expect(await count({ source: { kind: "workflow" } })).toBe(1)
        expect(await count({ source: { kind: "other" } })).toBe(1)
        expect(await count({ source: { kind: "agent" } })).toBe(0)
        expect(await count({ modelKind: "embedding" })).toBe(1)

        const groups = await storage.aiCosts.listModelCallGroups(twoDays)
        expect(groups.items.find((group) => group.executionId === "ben")?.requester).toEqual({
          type: "user",
          id: "usr_ben",
        })
        expect(groups.items.find((group) => group.executionId === "req")?.requester).toBeUndefined()
      } finally {
        await options.cleanup?.(storage)
      }
    })

    test("sums media per run, and tokenless calls leave no gap in its tokens", async () => {
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        const runs = {
          mixed: [
            { kind: "language", usage: { inputTokens: 2, outputTokens: 3 } },
            { kind: "image", usage: { outputImages: 2 } },
            { kind: "speech", usage: { inputCharacters: 12, audioDurationMs: 1160 } },
          ],
          images: [{ kind: "image", usage: { outputImages: 1 } }],
          gap: [
            { kind: "language", usage: {} },
            { kind: "image", usage: { outputImages: 1 } },
          ],
        } as const
        for (const [id, calls] of Object.entries(runs)) {
          const execution = await storage.executions.create({
            projectId,
            id,
            executor: { type: "request", requestId: id },
            source: { type: "http", requestId: id },
            correlationId: id,
            authorizationRef: { type: "disabled" },
          })
          for (const [index, call] of calls.entries()) {
            await storage.aiUsage.recordModelCall({
              projectId,
              id: `${id}:${index}`,
              executionId: execution.id,
              attempt: 1,
              callId: `${id}:${index}`,
              requesterGroupIds: [],
              providerId: "test",
              requestedModelId: call.kind,
              modelKind: call.kind,
              responseId: `${id}:${index}`,
              usage: call.usage,
              occurredAt: new Date("2026-09-01T12:00:00Z"),
            })
          }
        }

        const groups = await storage.aiCosts.listModelCallGroups(range)
        const group = (id: string) => {
          const found = groups.items.find((item) => item.executionId === id)
          return {
            totalTokens: found?.totalTokens,
            outputImages: found?.outputImages,
            inputCharacters: found?.inputCharacters,
            audioDurationMs: found?.audioDurationMs,
          }
        }
        expect(group("mixed")).toEqual({
          totalTokens: 5,
          outputImages: 2,
          inputCharacters: 12,
          audioDurationMs: 1160,
        })
        expect(group("images")).toEqual({
          totalTokens: undefined,
          outputImages: 1,
          inputCharacters: undefined,
          audioDurationMs: undefined,
        })
        // A language call without tokens is a real gap.
        expect(group("gap").totalTokens).toBeUndefined()
      } finally {
        await options.cleanup?.(storage)
      }
    })

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

    // Removal proof: key the groups by root execution again (aiModelCallGroupKey and the SQL
    // group_key returning root_execution_id); the turns then come back as two groups.
    test("lists a conversation's turns as one group, and sorts by cost", async () => {
      const storage = await options.createStorage()
      try {
        await options.setup?.(storage)
        await seed(storage)
        // A later turn in the first conversation, costlier than everything before it.
        const executionId = await createTestAgentExecution(storage, {
          projectId,
          runId: "third",
          executionId: "exec_third",
          authority: "inherited",
        })
        await storage.agents.runs.create({
          id: "third",
          projectId,
          executionId,
          threadId: "thread",
          triggerMessageId: "message_third",
          spec: { model: { provider: "parent-provider", modelId: "large" } },
        })
        const usage = await storage.aiUsage.recordModelCall({
          id: "usage_third",
          projectId,
          executionId,
          attempt: 1,
          callId: "call_third",
          requesterGroupIds: [],
          providerId: "parent-provider",
          requestedModelId: "large",
          responseId: "response_third",
          usage: { inputTokens: 40, cacheReadInputTokens: 30, outputTokens: 2 },
          occurredAt: new Date("2026-09-01T12:00:25Z"),
        })
        await storage.aiCosts.recordModelCallCost({
          projectId,
          usageRecordId: usage.record.id,
          status: "rated",
          billingIdentity: { providerId: "parent-provider", modelId: "large" },
          pricingContext: {},
          priceSource: {
            sourceId: "provider-reported",
            sourceEntryId: "cost_third",
            sourceVersion: "test",
            observedAt: new Date("2026-09-01T12:05:00Z"),
          },
          components: [],
          money: { currency: "USD", amountNanos: "1000" },
          ratedAt: new Date("2026-09-01T12:05:00Z"),
        })

        const recent = await storage.aiCosts.listModelCallGroups(range)
        expect(recent.total).toBe(2)
        expect(recent.items.map((group) => group.executionId)).toEqual([
          "exec_second",
          "exec_parent",
        ])
        expect(recent.items[1]).toMatchObject({
          modelCallCount: 33,
          attribution: { kind: "agent", agentRunId: "parent", threadId: "thread" },
          costs: { amounts: [{ currency: "EUR" }, { currency: "USD", amountNanos: "1300" }] },
        })
        expect(recent.items[1]?.executions.map((execution) => execution.executionId)).toEqual([
          "exec_parent",
          "exec_child",
          "exec_third",
        ])
        expect(recent.items[1]?.executions[2]).toMatchObject({
          inputTokens: 40,
          cacheReadInputTokens: 30,
          models: [
            {
              providerId: "parent-provider",
              modelId: "large",
              modelCallCount: 1,
              costs: { amounts: [{ currency: "USD", amountNanos: "1000" }] },
            },
          ],
        })

        // The second conversation has the latest call; the first costs more. A conversation whose
        // range opens inside a sub-agent still reads as the turn that started it.
        const byCost = await storage.aiCosts.listModelCallGroups({
          ...range,
          from: new Date("2026-09-01T12:00:20Z"),
          sort: "cost",
          limit: 1,
        })
        expect(byCost).toMatchObject({ total: 2, hasMore: true })
        expect(byCost.items.map((group) => group.executionId)).toEqual(["exec_parent"])
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
                ratedCallCount: 31,
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
          valuationStatus: "rated",
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
                ratedCallCount: 30,
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
    status: "rated",
    pricingContext: {},
    priceSource: {
      sourceId: "provider-reported",
      sourceEntryId: runId,
      sourceVersion: "1",
      observedAt: new Date("2026-09-01T12:00:00Z"),
    },
    components: [],
    billingIdentity: { providerId: "test", modelId: "small" },
    money: { currency: "USD", amountNanos: "10" },
    ratedAt: new Date("2026-09-01T12:00:00Z"),
  })
}

async function seed(storage: AiModelCallGroupsContractStorage) {
  for (const id of ["thread", "second_thread"]) {
    await storage.agents.threads.create({
      id,
      projectId,
      ownerPrincipal: { type: "user", id: "user" },
    })
  }
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
      threadId: runId === "parent" ? "thread" : "second_thread",
      triggerMessageId: `message_${runId}`,
      spec: { model: { provider: "parent-provider", modelId: "large" } },
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
        },
        thread: { id: "child_thread", create: true },
        trigger: { id: "child_task", parts: [{ type: "text", text: "Research" }] },
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
      status: "rated",
      billingIdentity: {
        providerId: child ? "child-provider" : "parent-provider",
        modelId: child ? "small" : "large",
      },
      pricingContext: {},
      priceSource: {
        sourceId: "provider-reported",
        sourceEntryId: `cost_${index}`,
        sourceVersion: "test",
        observedAt: new Date("2026-09-01T12:05:00Z"),
      },
      components: [],
      money: { currency: index === 0 ? "EUR" : "USD", amountNanos: index === 0 ? "0" : "10" },
      ratedAt: new Date("2026-09-01T12:05:00Z"),
    })
  }
}
