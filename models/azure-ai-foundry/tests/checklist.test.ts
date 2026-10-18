import { expect, test } from "bun:test"
import {
  type JsonObject,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  ModelProviderError,
} from "@sixb/core/models"
import { FoundryTransport } from "../src/transport"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://example.test/api/projects/test"
const request = (signal = new AbortController().signal): LanguageModelRequest => ({
  callId: "checklist",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
  maxOutputTokens: 16,
  signal,
})

function response(model: string): Response {
  const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
  return new Response(
    [
      { type: "response.created", response: { id: model, model } },
      { type: "response.output_text.delta", item_id: "text", delta: model },
      { type: "response.completed", response: { id: model, model, status: "completed", usage } },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")
  )
}

async function collect(events: AsyncIterable<LanguageModelStreamEvent>) {
  let text = ""
  let responseModelId: string | undefined
  let finish: Extract<LanguageModelStreamEvent, { type: "finish" }> | undefined
  for await (const event of events) {
    if (event.type === "error") throw event.error
    if (event.type === "text-delta") text += event.delta
    if (event.type === "response-metadata" && event.modelId) responseModelId = event.modelId
    if (event.type === "finish") {
      expect(finish).toBeUndefined()
      finish = event
    }
  }
  if (!finish) throw new Error("Missing finish")
  return { text, finish, responseModelId }
}

// Checklist coverage: simultaneous bindings through the same shared interface must
// not share cancellation, wire configuration, response identity or accounting state.
test("keeps concurrent bindings isolated through completion and cancellation", async () => {
  const entered = Promise.withResolvers<void>()
  const bodies: Record<string, JsonObject> = {}
  const p = createAzureAIFoundry({
    endpoint,
    apiKey: "test",
    fetch: async (_url, init) => {
      const body: JsonObject = JSON.parse(String(init?.body))
      const name = String(body.model)
      bodies[name] = body
      if (Object.keys(bodies).length === 2) entered.resolve()
      await entered.promise
      return response(name)
    },
  })
  const card = {
    currency: "USD",
    unit: "million-tokens",
    input: "1",
    output: "2",
    cacheReadInput: "0.1",
  } as const
  const alpha = p.responses("alpha", { rateCard: card, request: { temperature: 0.1 } })
  const beta = p.responses("beta", {
    rateCard: { ...card, input: "3", output: "4" },
    request: { temperature: 0.9 },
  })
  const abort = new AbortController()
  const [a, b] = await Promise.all([alpha.stream(request(abort.signal)), beta.stream(request())])
  abort.abort(new Error("cancel alpha only"))
  await expect(collect(a.events)).rejects.toThrow("cancel alpha only")
  const result = await collect(b.events)
  expect(result.text).toBe("beta")
  expect(result.finish).toMatchObject({
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  expect(result.finish.route?.modelId ?? result.responseModelId).toBe("beta")
  expect(
    beta.costEstimator.estimate({ usage: result.finish.usage, route: result.finish.route })
  ).toMatchObject({ status: "rated", money: { amountNanos: "50000" } })
  expect(alpha.costEstimator.estimate({ usage: result.finish.usage })).toMatchObject({
    status: "rated",
    money: { amountNanos: "20000" },
  })
  expect(bodies.alpha?.temperature).toBe(0.1)
  expect(bodies.beta?.temperature).toBe(0.9)
})

test("rejects unsupported media and aggregate byte overflow before inference", async () => {
  let calls = 0
  const p = createAzureAIFoundry({
    endpoint,
    apiKey: "test",
    fetch: async () => {
      calls++
      return response("model")
    },
  })
  const model = p.responses("model", {
    definition: { capabilities: { inputMediaTypes: "any" } },
    maxInputFileBytes: 7,
  })
  for (const mediaType of ["audio/wav", "video/mp4", "application/zip"])
    await expect(
      model.stream({
        ...request(),
        messages: [
          {
            role: "user",
            content: [{ type: "file", mediaType, data: new URL(`data:${mediaType};base64,YQ==`) }],
          },
        ],
      })
    ).rejects.toThrow("not supported")
  await expect(
    model.stream({
      ...request(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: new URL("data:image/png;base64,YWJjZA=="),
            },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: new URL("data:image/jpeg;base64,YWJjZA=="),
            },
          ],
        },
      ],
    })
  ).rejects.toThrow("maxInputFileBytes")
  expect(calls).toBe(0)
})

test.each([
  401, 408, 429, 500,
])("classifies HTTP %i and retains bounded diagnostics", async (status) => {
  let calls = 0
  const transport = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => {
      calls++
      return Response.json(
        { error: { code: "service_code", message: "Service diagnostic" } },
        { status, headers: { "request-id": "trace", "retry-after": "2" } }
      )
    },
  })
  await expect(
    transport.post("{}", new AbortController().signal, "provider", "deployment")
  ).rejects.toMatchObject({
    status,
    code: "service_code",
    requestId: "trace",
    retryAfterMs: 2000,
    retryable: status === 408 || status === 429 || status >= 500,
  })
  expect(calls).toBe(1)
})

test("honors Retry-After HTTP dates and retries only eligible HTTP responses", async () => {
  const retryDate = "Thu, 01 Jan 2099 00:00:00 GMT"
  const terminal = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => new Response(null, { status: 429, headers: { "retry-after": retryDate } }),
  })
  const started = Date.now()
  try {
    await terminal.post("{}", new AbortController().signal, "provider", "model")
    throw new Error("Expected throttling error")
  } catch (error) {
    if (!(error instanceof ModelProviderError)) throw error
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(Date.parse(retryDate) - Date.now())
    expect(error.retryAfterMs).toBeLessThanOrEqual(Date.parse(retryDate) - started)
  }
  let attempts = 0
  let credentials = 0
  const transport = new FoundryTransport({
    endpoint,
    maxRetries: 1,
    maxRetryDelayMs: 1,
    apiKey: () => `credential-${++credentials}`,
    fetch: async (_url, init) => {
      attempts++
      expect(new Headers(init?.headers).get("api-key")).toBe(`credential-${attempts}`)
      return attempts === 1
        ? Response.json(
            { error: { message: "busy" } },
            { status: 429, headers: { "retry-after": retryDate } }
          )
        : new Response("ok")
    },
  })
  expect((await transport.post("{}", AbortSignal.timeout(1000), "provider", "model")).ok).toBe(true)
  expect(attempts).toBe(2)
  let networkCalls = 0
  const network = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 3,
    fetch: async () => {
      networkCalls++
      throw new Error("socket closed")
    },
  })
  await expect(
    network.post("{}", new AbortController().signal, "provider", "model")
  ).rejects.toThrow("socket closed")
  expect(networkCalls).toBe(1)
})
