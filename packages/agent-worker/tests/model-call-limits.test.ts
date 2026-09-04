import { describe, expect, test } from "bun:test"
import { InMemoryStorage } from "@sixb/core/storage"
import { createTestAgentExecution } from "@sixb/core/testing"
import type { AiModelCallAdmissionInput } from "../src/model-call-admission"
import { createAiModelCallLimitController } from "../src/model-call-limits"

const projectId = "project_1"
const executionId = "test_agent_execution:run_limits"

function admission(callId: string, overrides: Partial<AiModelCallAdmissionInput> = {}) {
  return {
    projectId,
    executionId,
    attempt: 1,
    requesterGroupIds: ["support"],
    callId,
    providerId: "gateway",
    modelId: "openai/gpt-5",
    pricingContext: {},
    inputTokens: {
      status: "estimated" as const,
      tokens: 100,
      method: "utf8BytesDividedByFour" as const,
    },
    outputTokenAllowance: 4_096,
    estimatedTotalTokens: 4_196,
    ...overrides,
  }
}

async function storageWithExecution() {
  const storage = new InMemoryStorage()
  await createTestAgentExecution(storage, {
    projectId,
    agentId: "assistant",
    runId: "run_limits",
    executionId,
  })
  return storage
}

describe("AI model-call limits", () => {
  test("reserves every applicable attribution subject and denies concurrent overrun", async () => {
    const storage = await storageWithExecution()
    await storage.aiLimits.createPolicy({
      id: "project_tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 5_000 },
    })
    await storage.aiLimits.createPolicy({
      id: "support_tokens",
      projectId,
      subject: { type: "group", id: "support" },
      limit: { meter: "tokens.total", amount: 5_000 },
    })
    const controller = createAiModelCallLimitController({
      storage,
      projectId,
      requestedBy: { type: "user", id: "user_1" },
      requesterGroupIds: ["support"],
    })

    await expect(controller.beforeModelCall(admission("call_1"))).resolves.toEqual({
      reservation: "active",
    })
    const rejection = await Promise.resolve(controller.beforeModelCall(admission("call_2"))).catch(
      (error: unknown) => error
    )
    expect(rejection).toMatchObject({
      code: "ai.usage_limit_exceeded",
      details: {
        resetAt: expect.any(String),
      },
    })
    expect((rejection as { details?: unknown }).details).not.toHaveProperty("policies")
  })

  test("fails a catalog-cost policy closed when the model cannot be pre-priced", async () => {
    const storage = await storageWithExecution()
    await storage.aiLimits.createPolicy({
      id: "project_cost",
      projectId,
      subject: { type: "project" },
      limit: {
        meter: "cost.catalogEstimated",
        amount: { currency: "USD", amountNanos: "1000000000" },
      },
    })
    const controller = createAiModelCallLimitController({
      storage,
      projectId,
      requesterGroupIds: [],
    })

    await expect(
      controller.beforeModelCall(
        admission("call_unknown", { providerId: "custom", modelId: "private-model" })
      )
    ).rejects.toMatchObject({
      code: "ai.usage_limit_unavailable",
      details: { reasons: ["missingEstimate"] },
    })
  })

  test("moves a billed attempt without usage into unknown capacity", async () => {
    const storage = await storageWithExecution()
    await storage.aiLimits.createPolicy({
      id: "project_tokens",
      projectId,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 10_000 },
    })
    const controller = createAiModelCallLimitController({
      storage,
      projectId,
      requesterGroupIds: [],
    })
    await controller.beforeModelCall(admission("call_unknown"))
    await controller.markModelCallUnknown({
      projectId,
      executionId,
      attempt: 1,
      callId: "call_unknown",
    })

    await expect(storage.aiLimits.listPolicyStatuses({ projectId })).resolves.toMatchObject([
      {
        consumption: {
          actual: { amount: 0 },
          reserved: { amount: 0 },
          unknown: { amount: 4_196 },
          remaining: { amount: 5_804 },
        },
      },
    ])
  })
})
