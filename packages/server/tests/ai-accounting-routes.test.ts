import { describe, expect, test } from "bun:test"
import {
  type AuthorizationContext,
  defineGroup,
  emptyGrantIndex,
  type GroupDefinition,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  noopLoggerProvider,
  SixbHost,
} from "@sixb/core"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { createTestAgentExecution } from "@sixb/core/testing"
import { Elysia } from "elysia"
import { registerAiAccountingRoutes } from "../src/routes/ai-accounting"

const projectId = "ai-accounting-routes"

async function createApp() {
  const storage = new InMemoryStorage()
  await storage.agents.threads.create({
    id: "thread_1",
    projectId,
    agentId: "accounting-agent",
    ownerPrincipal: { type: "user", id: "user_1" },
  })
  const executionId = await createTestAgentExecution(storage, {
    projectId,
    agentId: "accounting-agent",
    runId: "run_1",
    executionId: "execution_1",
  })
  await storage.agents.runs.create({
    id: "run_1",
    projectId,
    executionId,
    threadId: "thread_1",
    agentId: "accounting-agent",
    triggerMessageId: "message_1",
    requesterGroupIds: [],
  })
  await storage.transaction(async (tx) => {
    const usage = await tx.aiUsage!.recordModelCall({
      id: "usage_1",
      projectId,
      executionId: "execution_1",
      attempt: 1,
      callId: "call_1",
      requesterGroupIds: [],
      providerId: "openai",
      requestedModelId: "gpt-5",
      responseId: "response_1",
      usage: { inputTokens: 10, outputTokens: 5, reasoningOutputTokens: 2 },
      occurredAt: new Date("2026-09-10T12:30:00.000Z"),
      recordedAt: new Date("2026-09-10T12:30:00.100Z"),
    })
    await tx.aiCosts!.recordModelCallCost({
      projectId,
      usageRecordId: usage.record.id,
      status: "unpriceable",
      billingIdentity: { providerId: "openai", modelId: "gpt-5" },
      pricingContext: { serviceTier: "priority" },
      priceSource: {
        sourceId: "test-catalog",
        sourceEntryId: "openai/gpt-5",
        sourceVersion: "test-catalog-v1",
        sourceUrl: "https://example.test/ai-pricing.json",
        observedAt: new Date("2026-09-10T12:00:00.000Z"),
      },
      reason: "unsupportedPricingDimension",
      ratedAt: new Date("2026-09-10T12:30:00.200Z"),
    })
  })
  return aiRoutes(createHost(storage))
}

function createHost(
  storage: InMemoryStorage,
  groups: readonly GroupDefinition[] = []
): SixbHost<readonly []> {
  return new SixbHost<readonly []>({
    id: projectId,
    ontology: [] as const,
    storage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    logger: noopLoggerProvider,
    groups,
  })
}

function aiRoutes(host: SixbHost<readonly []>, authorization?: AuthorizationContext) {
  const app = new Elysia()
  app.derive(({ request }) => ({
    sixb: bindRequestExecution(host, {
      request,
      authorization: authorization
        ? { type: "principal", context: authorization }
        : { type: "disabled" },
    }),
  }))
  return registerAiAccountingRoutes(app, host)
}

describe("AI accounting routes", () => {
  test("returns chart-ready project usage with honest pricing coverage", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/accounting/overview?" +
          new URLSearchParams({
            from: "2026-09-10T12:00:00.000Z",
            to: "2026-09-10T14:00:00.000Z",
            bucket: "hour",
          })
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      range: {
        from: "2026-09-10T12:00:00.000Z",
        to: "2026-09-10T14:00:00.000Z",
      },
      totals: {
        modelCallCount: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          reasoningOutputTokens: 2,
          reportingStatus: "complete",
        },
        costs: {
          amounts: [],
          ratedCallCount: 0,
          unpriceableCallCount: 1,
          unvaluedCallCount: 0,
        },
      },
      series: [
        { start: "2026-09-10T12:00:00.000Z", modelCallCount: 1 },
        { start: "2026-09-10T13:00:00.000Z", modelCallCount: 0 },
      ],
      models: [{ providerId: "openai", modelId: "gpt-5", modelCallCount: 1 }],
    })
  })

  test("lists model calls with pricing context and unpriceable diagnostics", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-calls?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            valuationStatus: "unpriceable",
          })
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      total: 1,
      hasMore: false,
      items: [
        {
          usage: {
            id: "usage_1",
            executionId: "execution_1",
            providerId: "openai",
            requestedModelId: "gpt-5",
          },
          attribution: {
            kind: "agent",
            agentId: "accounting-agent",
            agentRunId: "run_1",
            threadId: "thread_1",
          },
          cost: {
            status: "unpriceable",
            pricingContext: { serviceTier: "priority" },
            reason: "unsupportedPricingDimension",
          },
          valuationStatus: "unpriceable",
        },
      ],
    })
  })

  test("rejects malformed model-call pagination integers", async () => {
    const app = await createApp()
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/model-calls?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            limit: "25garbage",
          })
      )
    )
    expect(response.status).toBe(422)
  })

  test("reports unavailable AI cost storage explicitly", async () => {
    const storage = new InMemoryStorage()
    Object.defineProperty(storage, "aiCosts", { value: undefined })
    const app = aiRoutes(createHost(storage))
    const response = await app.handle(
      new Request(
        "http://localhost/api/ai/accounting/overview?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            bucket: "day",
          })
      )
    )
    expect(response.status).toBe(501)
  })

  test("requires observe:aiUsage for accounting and limit status", async () => {
    const host = createHost(new InMemoryStorage())
    const app = aiRoutes(host, aiUsageAuthorization())

    const accounting = await app.handle(
      new Request(
        "http://localhost/api/ai/accounting/overview?" +
          new URLSearchParams({
            from: "2026-09-10T00:00:00.000Z",
            to: "2026-09-11T00:00:00.000Z",
            bucket: "day",
          })
      )
    )
    const limits = await app.handle(new Request("http://localhost/api/ai/limits/status"))

    expect(accounting.status).toBe(403)
    expect(limits.status).toBe(403)
  })

  test("exposes status to observers without exposing mutation controls", async () => {
    const host = createHost(new InMemoryStorage())
    const app = aiRoutes(host, aiUsageAuthorization("observe"))

    const status = await app.handle(new Request("http://localhost/api/ai/limits/status"))
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ items: [], capabilities: { manage: false } })

    const create = await app.handle(
      jsonRequest("http://localhost/api/ai/limits", "POST", {
        subject: { type: "project" },
        limit: { meter: "tokens.total", amount: 100 },
      })
    )
    expect(create.status).toBe(403)
  })

  test("lists selectable limit subjects only for AI usage managers", async () => {
    const storage = new InMemoryStorage()
    await storage.auth.users.create({
      id: "usr_finance",
      projectId,
      email: "finance@example.com",
      displayName: "Finance Operator",
    })
    await storage.auth.users.create({
      id: "usr_suspended",
      projectId,
      email: "former@example.com",
      status: "suspended",
    })
    await storage.auth.serviceAccounts.create({
      id: "svc_billing",
      projectId,
      name: "Billing automation",
      description: "Rates monthly invoices",
    })
    const host = createHost(storage, [
      defineGroup("finance", { label: "Finance", description: "Finance team" }),
    ])

    const observer = aiRoutes(host, aiUsageAuthorization("observe"))
    const denied = await observer.handle(new Request("http://localhost/api/ai/limits/subjects"))
    expect(denied.status).toBe(403)

    const manager = aiRoutes(host, aiUsageAuthorization("manage"))
    const response = await manager.handle(new Request("http://localhost/api/ai/limits/subjects"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      groups: [{ id: "finance", label: "Finance", description: "Finance team" }],
      users: [
        {
          id: "usr_finance",
          email: "finance@example.com",
          displayName: "Finance Operator",
          status: "active",
        },
        {
          id: "usr_suspended",
          email: "former@example.com",
          status: "suspended",
        },
      ],
      serviceAccounts: [
        {
          id: "svc_billing",
          name: "Billing automation",
          description: "Rates monthly invoices",
          status: "active",
        },
      ],
    })

    const policies = await manager.handle(new Request("http://localhost/api/ai/limits"))
    expect(policies.status).toBe(200)
    expect(await policies.json()).toEqual({ items: [], capabilities: { manage: true } })
    const status = await manager.handle(new Request("http://localhost/api/ai/limits/status"))
    expect(status.status).toBe(403)
  })

  test("creates, reports, updates, and deletes exact AI usage-limit policies", async () => {
    const host = createHost(new InMemoryStorage())
    const app = aiRoutes(host, aiUsageAuthorization("observe", "manage"))

    const tokenCreate = await app.handle(
      jsonRequest("http://localhost/api/ai/limits", "POST", {
        subject: { type: "project" },
        limit: { meter: "tokens.total", amount: 1_000 },
      })
    )
    expect(tokenCreate.status).toBe(200)
    const tokenPolicy = (await tokenCreate.json()) as { id: string }

    const unsupportedCurrency = await app.handle(
      jsonRequest("http://localhost/api/ai/limits", "POST", {
        subject: { type: "group", id: "europe" },
        limit: {
          meter: "cost.catalogEstimated",
          amount: { currency: "EUR", amountNanos: "1234567890" },
        },
      })
    )
    expect(unsupportedCurrency.status).toBe(422)

    const costCreate = await app.handle(
      jsonRequest("http://localhost/api/ai/limits", "POST", {
        subject: { type: "group", id: "departed-group" },
        limit: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "1234567890" },
        },
        enabled: false,
      })
    )
    expect(costCreate.status).toBe(200)

    const duplicate = await app.handle(
      jsonRequest("http://localhost/api/ai/limits", "POST", {
        subject: { type: "project" },
        limit: { meter: "tokens.total", amount: 2_000 },
      })
    )
    expect(duplicate.status).toBe(409)

    const status = await app.handle(
      new Request(
        "http://localhost/api/ai/limits/status?" +
          new URLSearchParams({
            includeDisabled: "true",
          })
      )
    )
    expect(status.status).toBe(200)
    const statusBody = (await status.json()) as {
      capabilities: { manage: boolean }
      items: Array<Record<string, unknown> & { policy: Record<string, unknown> }>
    }
    expect(statusBody.capabilities).toEqual({ manage: true })
    expect(statusBody.items.find((item) => item.policy.id === tokenPolicy.id)).toMatchObject({
      policy: {
        id: tokenPolicy.id,
        subject: { type: "project" },
        limit: { meter: "tokens.total", amount: 1_000 },
      },
      consumption: {
        actual: { meter: "tokens.total", amount: 0 },
        reserved: { meter: "tokens.total", amount: 0 },
        unknown: { meter: "tokens.total", amount: 0 },
        remaining: { meter: "tokens.total", amount: 1_000 },
      },
      accountingStatus: "complete",
      exhausted: false,
    })
    expect(
      statusBody.items.find((item) => (item.policy.subject as { type?: string })?.type === "group")
    ).toMatchObject({
      policy: {
        subject: { type: "group", id: "departed-group" },
        limit: {
          meter: "cost.catalogEstimated",
          amount: { currency: "USD", amountNanos: "1234567890" },
        },
        enabled: false,
      },
      orphaned: true,
    })

    const update = await app.handle(
      jsonRequest(`http://localhost/api/ai/limits/${tokenPolicy.id}`, "PUT", {
        limit: { meter: "tokens.total", amount: 2_500 },
        enabled: false,
      })
    )
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({
      limit: { meter: "tokens.total", amount: 2_500 },
      enabled: false,
    })

    const deleted = await app.handle(
      new Request(`http://localhost/api/ai/limits/${tokenPolicy.id}`, { method: "DELETE" })
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ success: true })

    const missing = await app.handle(
      new Request(`http://localhost/api/ai/limits/${tokenPolicy.id}`, { method: "DELETE" })
    )
    expect(missing.status).toBe(404)
  })
})

function aiUsageAuthorization(
  ...capabilities: readonly ("observe" | "manage")[]
): AuthorizationContext {
  const grants = {
    ...emptyGrantIndex(),
    "observe:aiUsage": new Set(capabilities.includes("observe") ? ["aiUsage"] : []),
    "manage:aiUsage": new Set(capabilities.includes("manage") ? ["aiUsage"] : []),
  }
  return {
    principal: { type: "user", id: "ai-operator" },
    groupIds: [],
    roleIds: [],
    grants,
  }
}

function jsonRequest(url: string, method: "POST" | "PUT", body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
