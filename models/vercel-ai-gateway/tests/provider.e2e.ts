import { expect, test } from "bun:test"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { vercelGateway } from "../src"

const modelId = process.env.SIXB_VERCEL_GATEWAY_E2E_MODEL
const hasCredential = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN
const liveTest = hasCredential && modelId ? test : test.skip

liveTest(
  "streams one live Vercel AI Gateway response",
  async () => {
    const response = await vercelGateway(modelId!).stream({
      callId: `vercel-gateway-e2e-${crypto.randomUUID()}`,
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
