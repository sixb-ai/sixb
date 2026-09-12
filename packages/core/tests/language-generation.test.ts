import { describe, expect, test } from "bun:test"
import { decimal, SixbHost } from "../src"
import { bindDurablePrimitiveExecution } from "../src/execution/primitive"
import { bindRequestExecution } from "../src/execution/request"
import {
  defineLanguageModel,
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  ModelCatalogUnavailableError,
  ModelStreamError,
  rateModelCall,
  StructuredOutputError,
} from "../src/models"
import { createTestActionExecution } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

function fakeModel(
  options: {
    modelId?: string
    text?: string
    finishReason?: "stop" | "length" | "pause" | "error" | "content-filter"
    events?: (request: LanguageModelRequest) => AsyncIterable<LanguageModelStreamEvent>
  } = {}
) {
  const requests: LanguageModelRequest[] = []
  const modelId = options.modelId ?? "model"
  const model: LanguageModel = {
    providerId: "test",
    modelId,
    definition: defineLanguageModel({
      kind: "language",
      providerId: "test",
      modelId,
      maxOutputTokens: 1000,
      capabilities: { nativeStructuredOutput: true },
    }),
    costEstimator: {
      estimate: ({ usage }) =>
        rateModelCall({
          usage,
          rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
        }),
    },
    async stream(request) {
      requests.push(request)
      return {
        events: options.events
          ? options.events(request)
          : (async function* (): AsyncIterable<LanguageModelStreamEvent> {
              yield { type: "stream-start" }
              yield { type: "text-start", id: "text" }
              yield { type: "text-delta", id: "text", delta: options.text ?? "Hello" }
              yield { type: "text-end", id: "text" }
              yield {
                type: "finish",
                finishReason: options.finishReason ?? "stop",
                usage: { inputTokens: 10, outputTokens: 4 },
              }
            })(),
      }
    },
  }
  return { model, requests }
}

function setup(models?: readonly LanguageModel[], controller = new AbortController()) {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({
    id: "generation",
    ontology: [],
    ...deps,
    models: models ? { language: models } : undefined,
  })
  const sixb = bindRequestExecution(host, {
    request: new Request("http://localhost/generate", { signal: controller.signal }),
    authorization: { type: "disabled" },
  })
  const identity = { projectId: host.id, executionId: sixb.execution.id }
  return { ...deps, host, sixb, identity, controller }
}

describe("language generation", () => {
  test("pins requester groups across deliveries and uses real attempts and worker cancellation", async () => {
    // Removal proof: omit the execution signal from generate()'s combined signal.
    const { model, requests } = fakeModel()
    const { host, storage } = setup([model])
    const requesterGroupIds = ["admitted-group"]
    const executionId = await createTestActionExecution(storage.executions, {
      projectId: host.id,
      actionId: "extract",
      runId: "action",
      requesterGroupIds,
    })
    const execution = await storage.executions.getById({ projectId: host.id, id: executionId })
    if (!execution) throw new Error("Missing test execution")
    const controller = new AbortController()
    const first = bindDurablePrimitiveExecution(host, {
      execution,
      primitive: { kind: "action", id: "extract", runId: "action" },
      modelExecution: { attempt: 3, signal: controller.signal },
    }).sixb
    requesterGroupIds.push("later-group")
    const result = await first.models.language.generate({ prompt: "Hi" })
    const identity = { projectId: host.id, executionId }
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      attempt: 3,
      requesterGroupIds: ["admitted-group"],
    })
    controller.abort(new Error("worker stopped"))
    await expect(
      first.models.language.generate({ prompt: "Hi", signal: new AbortController().signal })
    ).rejects.toThrow("worker stopped")
    expect(requests).toHaveLength(1)
    const second = bindDurablePrimitiveExecution(host, {
      execution,
      primitive: { kind: "action", id: "extract", runId: "action" },
      modelExecution: {
        attempt: 4,
        signal: new AbortController().signal,
      },
    }).sixb
    const next = await second.models.language.generate({ prompt: "Retry" })
    expect(next.callId).not.toBe(result.callId)
    const calls = await storage.aiCosts.listModelCalls({
      projectId: host.id,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    })
    expect(calls.items.find((call) => call.usage.callId === next.callId)?.usage.attempt).toBe(4)
  })

  // Removal proof: bypass the recorder's onModelCallEnd in createModelsRuntime and run this file.
  test("returns text only after usage, valuation, and actuals are stored", async () => {
    const { model, requests } = fakeModel()
    const { sixb, storage, identity } = setup([model])
    const result = await sixb.models.language.generate({ instructions: "Be brief", prompt: "Hi" })
    expect(result).toMatchObject({
      output: "Hello",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4 },
      cost: { status: "rated" },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      maxOutputTokens: 1000,
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: [{ type: "text", text: "Hi" }] },
      ],
    })
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      callId: result.callId,
      attempt: 1,
      executionId: sixb.execution.id,
      usage: { totalTokens: 14 },
    })
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 1 })
    const calls = await storage.aiCosts.listModelCalls({
      projectId: identity.projectId,
      from: new Date("2000-01-01"),
      to: new Date("2100-01-01"),
    })
    expect(calls.total).toBe(1)
    expect(calls.items[0]?.cost).toMatchObject({ status: "rated", money: { amountNanos: "18000" } })
  })

  test("uses the configured binding for overrides and permits explicit models without a catalog", async () => {
    const first = fakeModel()
    const second = fakeModel({ modelId: "second", text: "Second" })
    const impostor = fakeModel({ modelId: "second", text: "Wrong binding" })
    const { sixb } = setup([first.model, second.model])
    expect(
      (await sixb.models.language.generate({ model: impostor.model, prompt: "Hi" })).output
    ).toBe("Second")
    expect(impostor.requests).toHaveLength(0)
    expect(first.requests).toHaveLength(0)
    expect(
      (await setup().sixb.models.language.generate({ model: first.model, prompt: "Hi" })).output
    ).toBe("Hello")
  })

  test("rejects missing models, unknown overrides, and conflicting inputs before inference", async () => {
    const known = fakeModel()
    const unknown = fakeModel({ modelId: "unknown" })
    await expect(setup().sixb.models.language.generate({ prompt: "Hi" })).rejects.toThrow(
      "Configure models.language"
    )
    const { sixb } = setup([known.model])
    await expect(
      sixb.models.language.generate({ model: unknown.model, prompt: "Hi" })
    ).rejects.toThrow("not configured")
    // @ts-expect-error runtime validation also protects JavaScript callers
    await expect(sixb.models.language.generate({ prompt: "Hi", messages: [] })).rejects.toThrow(
      "exactly one"
    )
    await expect(
      sixb.models.language.generate({ prompt: "Hi", maxOutputTokens: 0 })
    ).rejects.toThrow("positive safe integer")
    expect(known.requests).toHaveLength(0)
    expect(unknown.requests).toHaveLength(0)
  })

  test("preserves existing message order and applies the caller's stricter ceiling", async () => {
    const { model, requests } = fakeModel()
    const messages = [
      { role: "system" as const, content: "Original" },
      { role: "user" as const, content: [{ type: "text" as const, text: "Task" }] },
    ]
    await setup([model]).sixb.models.language.generate({
      messages,
      instructions: "First",
      maxOutputTokens: 17,
      caching: "off",
    })
    expect(requests[0]?.messages).toEqual([{ role: "system", content: "First" }, ...messages])
    expect(requests[0]).toMatchObject({ maxOutputTokens: 17, caching: "off" })
    expect(messages).toHaveLength(2)
  })

  test("validates and hydrates Sixb output shapes", async () => {
    const { model, requests } = fakeModel({
      text: JSON.stringify({ date: "2026-09-11", amount: "12.50", count: 2 }),
    })
    const { sixb } = setup([model])
    const { output } = await sixb.models.language.generate({
      prompt: "Extract",
      output: { date: "date", amount: "decimal", count: "integer" },
    })
    expect(output).toEqual({ date: new Date("2026-09-11"), amount: decimal("12.50"), count: 2 })
    expect(requests[0]?.responseFormat).toMatchObject({
      name: "sixb_output",
      schema: { type: "object", additionalProperties: false },
    })
  })

  test.each([
    "not JSON",
    '{"count":"wrong"}',
    "{}",
    '{"count":2,"extra":true}',
  ])("accounts for invalid structured output: %s", async (text) => {
    const { model, requests } = fakeModel({ text })
    const { sixb, storage, identity } = setup([model])
    await expect(
      sixb.models.language.generate({ prompt: "Extract", output: { count: "integer" } })
    ).rejects.toBeInstanceOf(StructuredOutputError)
    expect(requests).toHaveLength(1)
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 1 })
  })

  test("preserves output fields whose names also exist on Object.prototype", async () => {
    // Removal proof: build output with output[key] = value on {}; __proto__ disappears.
    const { model } = fakeModel({
      text: '{"__proto__":"value","constructor":"label"}',
    })
    const { output } = await setup([model]).sixb.models.language.generate({
      prompt: "Extract",
      output: { ["__proto__"]: "string", constructor: "string" },
    })
    expect(Object.hasOwn(output, "__proto__")).toBe(true)
    expect(output).toEqual(JSON.parse('{"__proto__":"value","constructor":"label"}'))
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
  })

  test("returns text truncation but rejects incomplete structured output", async () => {
    const { model } = fakeModel({ text: '{"count":2}', finishReason: "length" })
    const { sixb } = setup([model])
    expect((await sixb.models.language.generate({ prompt: "Hi" })).finishReason).toBe("length")
    await expect(
      sixb.models.language.generate({ prompt: "Hi", output: { count: "integer" } })
    ).rejects.toBeInstanceOf(StructuredOutputError)
  })

  test.each([
    "error",
    "content-filter",
    "pause",
  ] as const)("rejects %s without a continuation", async (finishReason) => {
    const { model, requests } = fakeModel({ finishReason })
    const { sixb, storage, identity } = setup([model])
    await expect(sixb.models.language.generate({ prompt: "Hi" })).rejects.toThrow()
    expect(requests).toHaveLength(1)
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 1 })
  })

  test("rejects local tool calls after accounting", async () => {
    // Removal proof: remove rejectLocalToolCalls from direct generation's loop options.
    const { model } = fakeModel({
      events: async function* () {
        yield { type: "stream-start" }
        yield { type: "tool-call", toolCallId: "tool", toolName: "unexpected", input: "{}" }
        yield { type: "finish", finishReason: "tool-calls", usage: {} }
      },
    })
    const { sixb, storage, identity } = setup([model])
    await expect(sixb.models.language.generate({ prompt: "Hi" })).rejects.toBeInstanceOf(
      ModelStreamError
    )
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 1 })
  })

  test("combines request and caller cancellation, recording an interrupted stream as unknown", async () => {
    const controller = new AbortController()
    const reason = new Error("request closed")
    const { model } = fakeModel({
      events: async function* (request) {
        yield { type: "stream-start" }
        controller.abort(reason)
        request.signal.throwIfAborted()
      },
    })
    const { sixb, storage, identity } = setup([model], controller)
    await expect(
      sixb.models.language.generate({ prompt: "Hi", signal: new AbortController().signal })
    ).rejects.toBe(reason)
    expect(await storage.aiUsage.getLatestForExecution(identity)).toMatchObject({
      usage: { reportingStatus: "unavailable" },
    })
  })

  test("reserves using the effective ceiling and denies a later call before inference", async () => {
    const { model, requests } = fakeModel()
    const { sixb, storage, host } = setup([model])
    await storage.aiLimits.createPolicy({
      id: "tokens",
      projectId: host.id,
      subject: { type: "project" },
      limit: { meter: "tokens.total", amount: 1100 },
    })
    await sixb.models.language.generate({ prompt: "Hi", maxOutputTokens: 9000 })
    expect(requests[0]?.maxOutputTokens).toBe(1000)
    const statuses = await storage.aiLimits.listPolicyStatuses({ projectId: host.id })
    expect(statuses[0]).toMatchObject({
      consumption: { actual: { amount: 14 }, reserved: { amount: 0 } },
    })
    await storage.aiLimits.updatePolicy({
      id: "tokens",
      projectId: host.id,
      limit: { meter: "tokens.total", amount: 1 },
    })
    await expect(sixb.models.language.generate({ prompt: "Hi" })).rejects.toMatchObject({
      code: "ai.usage_limit_exceeded",
    })
    expect(requests).toHaveLength(1)
  })

  test("concurrent generations have distinct call IDs in the same execution", async () => {
    const { model } = fakeModel()
    const { sixb, storage, identity } = setup([model])
    const results = await Promise.all([
      sixb.models.language.generate({ prompt: "One" }),
      sixb.models.language.generate({ prompt: "Two" }),
    ])
    expect(new Set(results.map((result) => result.callId)).size).toBe(2)
    expect(await storage.aiUsage.summarizeExecution(identity)).toMatchObject({ modelCallCount: 2 })
  })

  test("pins resolution once per generation with an offline catalog fallback", async () => {
    const pinned = fakeModel()
    const resolutions: boolean[] = []
    const selected: LanguageModel = {
      ...pinned.model,
      resolve: async (options) => {
        resolutions.push(options?.offline ?? false)
        if (!options?.offline) throw new ModelCatalogUnavailableError("offline")
        return pinned.model
      },
    }
    await setup([selected]).sixb.models.language.generate({ prompt: "Hi" })
    expect(resolutions).toEqual([false, true])
    expect(pinned.requests).toHaveLength(1)
  })
})
