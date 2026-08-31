import { expect, test } from "bun:test"
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
