import { expect, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import type {
  LanguageModelStreamEvent,
  ModelAssistantPart,
  ModelMessage,
  ModelStep,
  ModelToolResultPart,
} from "@sixb/core/models"
import { claudeCode } from "../src"

// Runs against the Claude Code signed in on this computer, and uses its plan or key.
const modelId = process.env.SIXB_CLAUDE_CODE_E2E_MODEL ?? "haiku"
const liveTest = process.env.SIXB_CLAUDE_CODE_E2E ? test : test.skip

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

const system: ModelMessage = {
  role: "system",
  content: "You are a terse inventory assistant. Use the lookup tool for stock questions.",
}

function user(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] }
}

function sessionOf(step: ModelStep): unknown {
  for (const part of step.content) {
    const data = part.type === "provider-state" ? undefined : part.providerData?.["claude-code"]
    if (typeof data === "object" && data !== null) return Reflect.get(data, "sessionId")
  }
  return undefined
}

/** The steps of a loop as the conversation the next turn sends. */
function conversation(steps: readonly ModelStep[]): ModelMessage[] {
  return steps.flatMap((step) => {
    const assistant: ModelAssistantPart[] = []
    const results: ModelToolResultPart[] = []
    for (const part of step.content) {
      if (part.type === "tool-result" && !part.providerExecuted) results.push(part)
      else assistant.push(part)
    }
    return [
      { role: "assistant", content: assistant },
      ...(results.length === 0 ? [] : [{ role: "tool" as const, content: results }]),
    ]
  })
}

liveTest(
  "answers through Claude Code, and names the session to resume",
  async () => {
    const response = await claudeCode(modelId).stream({
      callId: `claude-code-e2e-${crypto.randomUUID()}`,
      messages: [user("Reply with exactly: sixb-ok")],
      tools: [],
      signal: AbortSignal.timeout(90_000),
    })

    const events: LanguageModelStreamEvent[] = []
    for await (const event of response.events) events.push(event)

    const text = events.flatMap((event) => (event.type === "text-delta" ? [event.delta] : []))
    expect(text.join("")).toContain("sixb-ok")
    expect(
      events.some((event) => "providerData" in event && event.providerData?.["claude-code"])
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" })
  },
  100_000
)

liveTest(
  "runs Sixb's tools in Sixb's loop, and resumes the session for the results and the next turn",
  async () => {
    const model = claudeCode(modelId)
    const first = await runModelLoop({
      model,
      messages: [system, user("How many of item 7 are in stock? Call lookup once.")],
      tools: [lookupTool],
      maxSteps: 3,
      signal: AbortSignal.timeout(150_000),
    })
    if (first.status !== "completed") throw new Error(`The loop ended '${first.status}'.`)

    expect(first.steps.length).toBe(2)
    expect(first.steps[0]!.finishReason).toBe("tool-calls")
    expect(first.output).toContain("12")
    // The second step resumed the session, so it read the first from Claude Code's prompt cache.
    expect(first.steps[1]!.usage.cacheReadInputTokens ?? 0).toBeGreaterThan(0)

    const second = await runModelLoop({
      model,
      messages: [
        system,
        user("How many of item 7 are in stock? Call lookup once."),
        ...conversation(first.steps),
        user("Which item number did I ask about? Answer with the number only."),
      ],
      tools: [lookupTool],
      maxSteps: 2,
      signal: AbortSignal.timeout(150_000),
    })
    if (second.status !== "completed") throw new Error(`The loop ended '${second.status}'.`)
    expect(second.output).toContain("7")
    // The next turn resumed a copy of the session rather than starting one from a transcript.
    expect(sessionOf(first.steps[0]!)).toEqual(expect.any(String))
    expect(second.steps[0]!.usage.cacheReadInputTokens ?? 0).toBeGreaterThan(0)
  },
  320_000
)

// Guard proof: drop `forkSession` from the resume options in provider.ts. Claude Code then reads
// the refusal it recorded when the first call stopped at its tool call in place of Sixb's result,
// and the answer misses the first stock level.
liveTest(
  "keeps each tool result through later calls of the same turn",
  async () => {
    const stock: Record<string, string> = { "7": "12 in stock", "9": "31 in stock" }
    const result = await runModelLoop({
      model: claudeCode(modelId),
      messages: [
        system,
        user(
          "Look up item 7, and only after its result arrives, look up item 9: one call at a time. Then give both stock levels."
        ),
      ],
      tools: [
        {
          ...lookupTool,
          execute: async (input: unknown) =>
            stock[String(Reflect.get(Object(input), "item"))] ?? "unknown item",
        },
      ],
      maxSteps: 4,
      signal: AbortSignal.timeout(200_000),
    })
    if (result.status !== "completed") throw new Error(`The loop ended '${result.status}'.`)

    expect(result.steps.length).toBe(3)
    expect(result.output).toContain("12")
    expect(result.output).toContain("31")
  },
  240_000
)

liveTest(
  "starts over from a transcript when Claude Code no longer has the session",
  async () => {
    const missing = { sessionId: crypto.randomUUID(), at: crypto.randomUUID() }
    const result = await runModelLoop({
      model: claudeCode(modelId),
      messages: [
        system,
        user("Remember the code word: heron."),
        {
          role: "assistant",
          content: [{ type: "text", text: "Noted.", providerData: { "claude-code": missing } }],
        },
        user("What was the code word? Answer with the word only."),
      ],
      maxSteps: 1,
      signal: AbortSignal.timeout(150_000),
    })
    if (result.status !== "completed") throw new Error(`The loop ended '${result.status}'.`)

    expect(result.output.toLowerCase()).toContain("heron")
  },
  160_000
)

liveTest(
  "returns structured output as the answer's text",
  async () => {
    const result = await runModelLoop({
      model: claudeCode(modelId),
      messages: [user("What is the capital of France?")],
      output: {
        name: "capital",
        schema: {
          type: "object",
          properties: { capital: { type: "string" } },
          required: ["capital"],
          additionalProperties: false,
        },
        validate: (value: unknown) => {
          if (typeof value !== "object" || value === null || !("capital" in value)) {
            throw new TypeError("Expected an object with a capital.")
          }
          return { capital: String(value.capital) }
        },
      },
      maxSteps: 1,
      signal: AbortSignal.timeout(150_000),
    })
    if (result.status !== "completed") throw new Error(`The loop ended '${result.status}'.`)

    expect(result.output.capital).toBe("Paris")
  },
  160_000
)

liveTest(
  "lists the models Claude Code offers its account",
  async () => {
    const models = await claudeCode.catalog.list()

    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.providerId === "claude-code")).toBe(true)
    expect(models.some((model) => model.modelId === modelId)).toBe(true)
  },
  60_000
)
