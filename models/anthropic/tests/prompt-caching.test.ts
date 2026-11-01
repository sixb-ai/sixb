import { describe, expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type { LanguageModelRequest, ModelMessage } from "@sixb/core/models"
import { agentTraceFromModelSteps } from "../../../packages/agent/src/model-adapters"
import { type AnthropicModelOptions, createAnthropic } from "../src"

type Body = Record<string, unknown>

const system: ModelMessage = { role: "system", content: "You are the project's agent." }

const tools = ["lookup", "search"].map((name) => ({
  name,
  description: `Run ${name}.`,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  parseInput: (value: unknown) => value,
  execute: async () => `${name} result`,
  errorText: () => `${name} failed`,
}))

function user(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

/** Claude 5 answers: signed thinking, then two parallel tool calls until the last step. */
function answer(step: number, finalStep: number): Response {
  const blocks =
    step < finalStep
      ? [
          { type: "tool_use", id: `toolu-${step}-a`, name: "lookup", input: { query: "a" } },
          { type: "tool_use", id: `toolu-${step}-b`, name: "search", input: { query: "b" } },
        ]
      : [{ type: "text", text: "Done." }]
  const events = [
    { type: "message_start", message: { id: `msg-${step}`, usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan." } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    ...blocks.flatMap((block, offset) => [
      { type: "content_block_start", index: offset + 1, content_block: block },
      { type: "content_block_stop", index: offset + 1 },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: step < finalStep ? "tool_use" : "end_turn" },
    },
    { type: "message_stop" },
  ]
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } }
  )
}

function agent(options: AnthropicModelOptions = {}, finalStep = 3) {
  const bodies: Body[] = []
  let step = 0
  const model = createAnthropic({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      step += 1
      return answer(step, finalStep)
    },
  })("claude-opus-5-5", options)
  return { model, bodies, restart: () => (step = 0) }
}

function turn(model: ReturnType<typeof agent>["model"], messages: ModelMessage[]) {
  return runModelLoop({
    model,
    messages,
    tools,
    maxSteps: 3,
    signal: new AbortController().signal,
  })
}

/** The request as Anthropic renders it for caching: the moving markers are not part of the key. */
function unmarked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarked)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [key, unmarked(entry)])
  )
}

/** Asserts `next` repeats every cached input of `previous` byte for byte, then only appends. */
function expectPrefix(previous: Body, next: Body) {
  const [before, after] = [unmarked(previous) as Body, unmarked(next) as Body]
  for (const key of ["model", "tools", "system", "thinking", "output_config"]) {
    expect(after[key]).toEqual(before[key])
  }
  const earlier = before.messages as unknown[]
  expect((after.messages as unknown[]).slice(0, earlier.length)).toEqual(earlier)
}

function markers(body: Body): unknown[] {
  const found: unknown[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (value === null || typeof value !== "object") return
    for (const [key, entry] of Object.entries(value)) {
      if (key === "cache_control") found.push(entry)
      else visit(entry)
    }
  }
  visit(body)
  return found
}

describe("Anthropic prompt caching", () => {
  test("marks tools, the system prompt and the conversation tail on every agent step", async () => {
    // Regression proof: return body unchanged from withPromptCaching.
    const { model, bodies } = agent()
    await turn(model, [system, user("Find it.")])

    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.cache_control).toEqual({ type: "ephemeral" })
      expect((body.tools as Body[]).at(-1)?.cache_control).toEqual({ type: "ephemeral" })
      expect((body.tools as Body[])[0]).not.toHaveProperty("cache_control")
      expect((body.system as Body[]).at(-1)?.cache_control).toEqual({ type: "ephemeral" })
      // Anthropic allows four breakpoints; automatic caching takes one.
      expect(markers(body)).toHaveLength(3)
    }
  })

  test("each agent step repeats the previous request exactly, so it reads that step's cache", async () => {
    // Regression proof: drop the replayed thinking signature, or reorder tools between steps.
    const { model, bodies } = agent()
    await turn(model, [system, user("Find it.")])

    expectPrefix(bodies[0]!, bodies[1]!)
    expectPrefix(bodies[1]!, bodies[2]!)
    // A step appends one assistant message and one run of tool results: well inside the 20-block
    // lookback that automatic caching searches for the previous entry.
    const added = (bodies[2]!.messages as Body[]).slice((bodies[1]!.messages as Body[]).length)
    expect(added.map((message) => message.role)).toEqual(["assistant", "user"])
    expect((added[0]!.content as Body[])[0]).toMatchObject({ type: "thinking", signature: "sig" })
  })

  test("a replayed turn repeats the previous turn's last request", async () => {
    const { model, bodies, restart } = agent()
    const opening = [system, user("Find it.")]
    const first = await turn(model, opening)
    const lastOfFirstTurn = bodies.at(-1)!

    restart()
    const history = toModelMessages([
      { role: "assistant", parts: agentTraceFromModelSteps(first.steps) },
    ])
    await turn(model, [...opening, ...history, user("And the next one?")])

    expectPrefix(lastOfFirstTurn, bodies[3]!)
  })

  test("leaves one-shot requests uncached: nothing would read their prefix again", async () => {
    // Regression proof: mark every request; compaction summaries and generate() pay 1.25x input.
    const { model, bodies } = agent()
    await runModelLoop({
      model,
      messages: [system, user("Summarize this thread.")],
      maxSteps: 1,
      signal: new AbortController().signal,
    })

    expect(markers(bodies[0]!)).toEqual([])
  })

  test("caches a conversation without tools once it has an earlier answer", async () => {
    const { model, bodies } = agent()
    await model.stream(
      request([
        system,
        user("Hello"),
        { role: "assistant", content: [{ type: "text", text: "Hi." }] },
        user("Again"),
      ])
    )

    expect(bodies[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect((bodies[0]?.system as Body[]).at(-1)?.cache_control).toEqual({ type: "ephemeral" })
    expect(bodies[0]).not.toHaveProperty("tools")
  })

  test("follows the request's caching choice", async () => {
    const { model, bodies } = agent()
    await model.stream(request([system, user("One shot.")], { caching: "auto" }))
    await model.stream(
      request([system, user("Agent step.")], {
        caching: "off",
        tools: [{ name: "lookup", description: "Run lookup.", inputSchema: { type: "object" } }],
      })
    )

    expect(bodies[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(markers(bodies[1]!)).toEqual([])
  })

  test("uses the binding's cache_control TTL for every breakpoint", async () => {
    // Anthropic rejects a one-hour entry after a five-minute one, so all markers share the TTL.
    const ttl = { type: "ephemeral", ttl: "1h" }
    const { model, bodies } = agent({ request: { cache_control: ttl } })
    await turn(model, [system, user("Find it.")])

    expect(markers(bodies[0]!)).toEqual([ttl, ttl, ttl])
  })

  test("keeps a long-lived prompt an hour on every breakpoint", async () => {
    // Regression proof: build the marker without the intent's lifetime; a conversation's reply
    // after 5 minutes rewrites its whole history.
    const ttl = { type: "ephemeral", ttl: "1h" }
    const { model, bodies } = agent()
    await model.stream(
      request([system, user("Find it.")], { tools, caching: { lifetime: "long", key: "k" } })
    )
    await model.stream(request([system, user("Find it.")], { tools, caching: { key: "k" } }))
    await model.stream(request([system, user("One shot.")], { caching: { lifetime: "long" } }))

    expect(markers(bodies[0]!)).toEqual([ttl, ttl, ttl])
    expect(markers(bodies[1]!)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
      { type: "ephemeral" },
    ])
    // An intent caches what an absent choice would: a one-shot request is left alone.
    expect(markers(bodies[2]!)).toEqual([])
  })

  test("keeps the binding's TTL over a long-lived intent", async () => {
    const ttl = { type: "ephemeral", ttl: "5m" }
    const { model, bodies } = agent({ request: { cache_control: ttl } })
    await model.stream(
      request([system, user("Find it.")], { tools, caching: { lifetime: "long" } })
    )

    expect(markers(bodies[0]!)).toEqual([ttl, ttl, ttl])
  })

  test("keeps the system and tail breakpoints when a step sends no tools", async () => {
    // The model loop's reserved last step sends no tools; server tools take no local marker.
    const { model, bodies } = agent({
      providerTools: [{ type: "web_search_20260209", name: "web_search" }],
    })
    await model.stream(
      request([
        system,
        user("Hello"),
        { role: "assistant", content: [{ type: "text", text: "Hi." }] },
        user("Wrap up."),
      ])
    )

    expect((bodies[0]?.tools as Body[])[0]).not.toHaveProperty("cache_control")
    expect(markers(bodies[0]!)).toHaveLength(2)
  })
})

function request(
  messages: ModelMessage[],
  overrides: Partial<LanguageModelRequest> = {}
): LanguageModelRequest {
  return {
    callId: "call-1",
    messages,
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}
