import { expect, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { anthropic } from "../src"

const modelId = process.env.SIXB_ANTHROPIC_E2E_MODEL
const liveTest = process.env.ANTHROPIC_API_KEY && modelId ? test : test.skip

liveTest(
  "streams one live Anthropic response",
  async () => {
    const response = await anthropic(modelId!).stream({
      callId: `anthropic-e2e-${crypto.randomUUID()}`,
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply with exactly: sixb-ok" }] },
      ],
      tools: [],
      signal: AbortSignal.timeout(60_000),
    })

    const events: LanguageModelStreamEvent[] = []
    for await (const event of response.events) events.push(event)

    expect(events.some((event) => event.type === "text-delta")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "finish" })
  },
  70_000
)

// Larger than every model's minimum cacheable prefix (4,096 tokens on the oldest supported models).
const cachedSystem = Array.from(
  { length: 400 },
  (_, index) =>
    `Rule ${index + 1}: questions about item ${index + 1} use the code ITEM-${index + 1}.`
).join("\n")

const lookupTool = {
  name: "lookup",
  description: "Look up an item's stock level.",
  inputSchema: {
    type: "object",
    properties: { item: { type: "string" } },
    required: ["item"],
    additionalProperties: false,
  },
  parseInput: (value: unknown) => value,
  execute: async () => "12 in stock",
  errorText: () => "lookup failed",
}

function cachedAgentTurn(question: string) {
  return runModelLoop({
    model: anthropic(modelId!),
    messages: [
      { role: "system", content: cachedSystem },
      { role: "user", content: [{ type: "text", text: question }] },
    ],
    tools: [lookupTool],
    maxSteps: 3,
    signal: AbortSignal.timeout(120_000),
  })
}

liveTest(
  "reads the previous step's cache within an agent turn, and the shared prefix across threads",
  async () => {
    const first = await cachedAgentTurn("Call lookup for item 7 once, then report the stock.")
    expect(first.steps.length).toBeGreaterThan(1)
    // The second step reads tools, system prompt and the first step from the cache.
    expect(first.steps[1]!.usage.cacheReadInputTokens ?? 0).toBeGreaterThan(4_000)

    // Another thread shares tools and system prompt, but not its conversation.
    const second = await cachedAgentTurn("Call lookup for item 9 once, then report the stock.")
    expect(second.steps[0]!.usage.cacheReadInputTokens ?? 0).toBeGreaterThan(4_000)
  },
  250_000
)
