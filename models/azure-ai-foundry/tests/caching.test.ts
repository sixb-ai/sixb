import { expect, test } from "bun:test"
import type { JsonObject, LanguageModel, LanguageModelRequest } from "@sixb/core/models"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
const definition = { capabilities: { localTools: true } }
const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object" } }]
const conversation = { lifetime: "long" as const, key: "thread-1" }
const FIELDS = ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options"]

function sse(events: readonly (JsonObject | string)[]): Response {
  return new Response(
    events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join("")
  )
}

const answered = (url: string) =>
  url.endsWith("/chat/completions")
    ? sse([
        {
          id: "c",
          model: "m",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        "[DONE]",
      ])
    : sse([
        { type: "response.created", response: { id: "r", model: "m" } },
        {
          type: "response.completed",
          response: { id: "r", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
        },
      ])

/** The caching settings of each request a provider sent. */
function setup(respond: (body: JsonObject, url: string) => Response = (_, url) => answered(url)) {
  const sent: JsonObject[] = []
  const foundry = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (url, init) => {
      const body: JsonObject = JSON.parse(String(init?.body))
      sent.push(Object.fromEntries(Object.entries(body).filter(([k]) => FIELDS.includes(k))))
      return respond(body, String(url))
    },
  })
  return { foundry, sent }
}

async function send(model: LanguageModel, overrides: Partial<LanguageModelRequest> = {}) {
  const { events } = await model.stream({
    callId: "call",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: AbortSignal.timeout(1000),
    ...overrides,
  })
  for await (const event of events) if (event.type === "error") throw event.error
}

// Regression proof: drop the prompt_cache_options line in promptCaching; one-shot requests then
// write a cache, at 1.25 times input, that nothing reads.
test("GPT-5.6 and later cache agent steps and write nothing for one-shot requests", async () => {
  const { foundry, sent } = setup()
  const gpt = foundry.responses("gpt-6", {
    definition,
    identity: { publisher: "OpenAI", modelName: "gpt-6.2-sol" },
  })
  await send(gpt, { tools, caching: conversation })
  await send(gpt, { caching: conversation })
  await send(gpt, { tools, caching: "off" })
  expect(sent).toEqual([
    { prompt_cache_key: "thread-1" },
    { prompt_cache_key: "thread-1", prompt_cache_options: { mode: "explicit" } },
    { prompt_cache_options: { mode: "explicit" } },
  ])
})

// Regression proof: drop the prompt_cache_retention line in promptCaching; the conversation's
// cache then lasts Azure's 5 to 10 idle minutes.
test("earlier GPT models keep a conversation's cache for 24 hours, on Chat too", async () => {
  const { foundry, sent } = setup()
  const identity = { publisher: "OpenAI", modelName: "gpt-5.4-mini" }
  const responses = foundry.responses("gpt-5", { definition, identity })
  await send(responses, { tools, caching: conversation })
  await send(responses, { caching: conversation })
  await send(responses, { tools, caching: { key: "thread-2" } })
  await send(foundry.chat("gpt-5", { definition, identity }), { tools, caching: conversation })
  const kept = { prompt_cache_key: "thread-1", prompt_cache_retention: "24h" }
  expect(sent).toEqual([
    kept,
    { prompt_cache_key: "thread-1" },
    { prompt_cache_key: "thread-2" },
    kept,
  ])
})

test("other publishers get the conversation's key", async () => {
  const { foundry, sent } = setup()
  const kimi = foundry.chat("kimi", { definition, identity: { publisher: "MoonshotAI" } })
  await send(kimi, { tools, caching: conversation })
  await send(kimi)
  expect(sent).toEqual([{ prompt_cache_key: "thread-1" }, {}])
})

test("the binding's own caching settings win", async () => {
  const { foundry, sent } = setup()
  const own = { mode: "implicit", ttl: "12h" }
  const gpt = foundry.responses("gpt-6-own", {
    definition,
    identity: { publisher: "OpenAI", modelName: "gpt-6.2-sol" },
    request: { prompt_cache_options: own },
  })
  await send(gpt, { caching: conversation })
  expect(sent).toEqual([{ prompt_cache_key: "thread-1", prompt_cache_options: own }])
})

// Regression proof: remove the refusedCaching retry in postOpenAICompatible; the first call fails.
// Remove the refusals check in promptCaching; every call sends the refused setting first.
test("a caching setting Azure refuses is dropped from the deployment's later requests", async () => {
  const { foundry, sent } = setup((body, url) =>
    "prompt_cache_retention" in body
      ? Response.json(
          { error: { message: "prompt_cache_retention is not supported on this model" } },
          { status: 400 }
        )
      : answered(url)
  )
  const gpt = foundry.responses("gpt-refusing", {
    definition,
    identity: { publisher: "OpenAI", modelName: "gpt-5.4-mini" },
  })
  await send(gpt, { tools, caching: conversation })
  await send(gpt, { tools, caching: conversation })
  expect(sent).toEqual([
    { prompt_cache_key: "thread-1", prompt_cache_retention: "24h" },
    { prompt_cache_key: "thread-1" },
    { prompt_cache_key: "thread-1" },
  ])
  const failing = setup(() =>
    Response.json({ error: { message: "Invalid prompt" } }, { status: 400 })
  )
  const other = failing.foundry.responses("gpt-invalid", {
    definition,
    identity: { publisher: "OpenAI", modelName: "gpt-5.4-mini" },
  })
  const error = await send(other, { tools, caching: conversation }).catch((e: unknown) => e)
  expect(String(error)).toContain("Invalid prompt")
  expect(failing.sent).toHaveLength(1)
})
