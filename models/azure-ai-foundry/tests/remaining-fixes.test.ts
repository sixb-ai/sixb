import { expect, test } from "bun:test"
import type { JsonObject } from "@sixb/core/models"
import { decodeServerSentEvents } from "../../protocols/src/sse"
import { createAzureAIFoundry as createDiscoveredProvider } from "../src"
import { foundryMessagesEstimator, foundryMessagesUsage } from "../src/messages-accounting"
import { createAzureAIFoundry } from "./provider-fixture"

// Removal proof: restore unconditional zero TTL components in partitionInputUsage.
test("zero cache partitions need no price; positive missing cache rates remain unpriceable", () => {
  const estimator = foundryMessagesEstimator(
    { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
    undefined
  )
  for (const ttl of [false, true]) {
    const raw = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(ttl
        ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }
        : {}),
    }
    expect(estimator.estimate({ usage: foundryMessagesUsage(raw) })).toMatchObject({
      status: "rated",
      money: { amountNanos: "20000" },
    })
  }
  const extras: JsonObject[] = [
    { cache_read_input_tokens: 1 },
    { cache_creation_input_tokens: 1 },
    {
      cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 },
    },
    {
      cache_creation_input_tokens: 1,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1 },
    },
  ]
  for (const extra of extras) {
    expect(
      estimator.estimate({
        usage: foundryMessagesUsage({
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          ...extra,
        }),
      })
    ).toMatchObject({ status: "unpriceable", reason: "missing-rate-card" })
  }
})

// Removal proof: await reader.cancel() in the SSE finally block; watchdog wins.
test.each([
  "return",
  "throw",
  "abort",
])("uncooperative SSE cleanup preserves %s without hanging", async (mode) => {
  const cleanup = Promise.withResolvers<void>()
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("data: hello\n\n"))
    },
    cancel() {
      return cleanup.promise
    },
  })
  const iterator = decodeServerSentEvents(body, controller.signal)[Symbol.asyncIterator]()
  await iterator.next()
  const reason = new Error("consumer stopped")
  if (mode === "abort") controller.abort(reason)
  const pending = (
    mode === "return"
      ? iterator.return!()
      : mode === "throw"
        ? iterator.throw!(reason)
        : iterator.next()
  ).then(
    () => "done",
    (error) => error
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("watchdog"), 100)
      }),
    ])
    expect(result).toBe(mode === "return" ? "done" : reason)
    expect(body.locked).toBe(false)
  } finally {
    clearTimeout(timer)
    cleanup.resolve()
    await pending
  }
})

// Removal proof: bypass transport diagnostic redaction; the synthetic credential
// appears in HTTP and streamed errors, including code/requestId and serialized stack.
test.each([
  "http",
  "chat",
  "responses",
  "messages",
] as const)("redacts credentials from %s diagnostics", async (kind) => {
  const secret = "sentinel-credential-739"
  const custom = "sentinel-custom-482"
  const provider = createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: secret,
    headers: { "x-custom-credential": custom },
    maxRetries: 0,
    fetch: async () =>
      kind === "http"
        ? Response.json(
            { error: { message: `Rejected ${secret} ${custom}`, code: secret } },
            { status: 401, headers: { "request-id": custom } }
          )
        : new Response(
            `data: ${JSON.stringify({ type: "error", error: { message: `Rejected ${secret} ${custom}`, code: secret, type: secret } })}\n\n`,
            { headers: { "request-id": custom } }
          ),
  })
  const model = provider[kind === "http" ? "chat" : kind]("model")
  let caught: unknown
  try {
    for await (const event of (
      await model.stream({
        callId: "audit",
        messages: [],
        tools: [],
        maxOutputTokens: 16,
        signal: AbortSignal.timeout(1000),
      })
    ).events)
      if (event.type === "error") throw event.error
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught))
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain(custom)
  expect(serialized).toContain("[REDACTED]")
})

test("redaction follows refreshed credentials and isolates concurrent streams", async () => {
  let tokens = 0
  const attempts = new Map<string, number>()
  const p = createAzureAIFoundry({
    endpoint: "https://example.test/api/projects/test",
    apiKey: () => `refresh-secret-${++tokens}`,
    maxRetries: 1,
    fetch: async (_url, init) => {
      const model = JSON.parse(String(init?.body)).model as string
      const attempt = (attempts.get(model) ?? 0) + 1
      attempts.set(model, attempt)
      const token = new Headers(init?.headers).get("api-key")!
      if (attempt === 1)
        return Response.json(
          { error: { message: token } },
          { status: 429, headers: { "retry-after-ms": "0" } }
        )
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(`body failed: ${token}`))
          },
        })
      )
    },
  })
  await Promise.all(
    ["alpha", "beta"].map(async (name) => {
      let caught: unknown
      try {
        for await (const _event of (
          await p.chat(name).stream({
            callId: name,
            messages: [],
            tools: [],
            maxOutputTokens: 16,
            signal: AbortSignal.timeout(1000),
          })
        ).events) {
        }
      } catch (error) {
        caught = error
      }
      expect(String(caught)).toContain("[REDACTED]")
      expect(String(caught)).not.toContain("refresh-secret-")
      expect(attempts.get(name)).toBe(2)
    })
  )
  expect(tokens).toBe(5)
})

// Removal proof: remove discovery's request-scoped sanitization; the nested
// catalog failure exposes the synthetic token through its cause/requestId.
test.each(["http", "network", "body"])("redacts discovery %s diagnostics", async (kind) => {
  const token = "discovery-sentinel-token"
  const provider = createDiscoveredProvider({
    endpoint: "https://example.test/api/projects/test",
    apiKey: () => token,
    fetch: async () => {
      if (kind === "network") throw new Error(`fetch failed ${token}`)
      if (kind === "body")
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error(`read failed ${token}`))
            },
          })
        )
      return new Response(null, { status: 401, headers: { "request-id": token } })
    },
  })
  let caught: unknown
  try {
    await provider.catalog.deployments()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(Error)
  const serialized = JSON.stringify(caught, [
    "name",
    "message",
    "stack",
    "cause",
    "requestId",
    "status",
  ])
  expect(serialized).not.toContain(token)
  expect(serialized).toContain("[REDACTED]")
})
