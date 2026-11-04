import { describe, expect, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import type { LanguageModel, LanguageModelStreamEvent } from "@sixb/core/models"
import { createVercelGateway } from "@sixb/vercel-ai-gateway"
import { WebFetchCache } from "../src/tools/web-fetch/cache"
import { createWebFetchTool, type WebFetchToolOutput } from "../src/tools/web-fetch/tool"

// Paid: one real fetch from the public web and one question to a small Gateway model, a fraction
// of a cent. Never in CI or `test:e2e`; run it by hand:
//   SIXB_LIVE=1 bun --env-file ~/sixb/internal/.env test packages/agent/tests/web-fetch.live.e2e.ts
const enabled = process.env.SIXB_LIVE === "1" && Boolean(process.env.AI_GATEWAY_API_KEY)

const MODEL_ID = "openai/gpt-5.6-luna"

describe.skipIf(!enabled)("web_fetch (live)", () => {
  test("reads a public page and answers a question from it", async () => {
    const charged: bigint[] = []
    const model = recordingCost(
      await resolveLanguageModel(createVercelGateway()(MODEL_ID)),
      charged
    )
    const tool = createWebFetchTool({
      web: {},
      network: "server",
      files: { store: async (_tool, bytes) => `page-${bytes.byteLength}.md` },
      model,
      cache: new WebFetchCache(),
    })

    const context = { signal: AbortSignal.timeout(60_000), callId: "live", toolCallId: "fetch_1" }
    const output = (await tool.execute(
      tool.parseInput({
        url: "https://en.wikipedia.org/wiki/HTTP_404",
        question: "What does the 404 status code tell the client? Answer in one sentence.",
      }),
      context
    )) as unknown as WebFetchToolOutput

    expect(output.status).toBe(200)
    expect(output.source.title).toContain("404")
    expect(output.answerError).toBeUndefined()
    expect(output.answer).toMatch(/not found|resource|page/i)

    const total = charged.reduce((sum, nanos) => sum + nanos, 0n)
    console.log(
      `[live] ${MODEL_ID}: $${Number(total) / 1e9}, ${output.bytes} bytes fetched, answer: ${output.answer}`
    )
  }, 60_000)
})

/** The model, adding what Gateway reports each call cost to `charged`. */
function recordingCost(model: LanguageModel, charged: bigint[]): LanguageModel {
  return {
    ...model,
    definition: model.definition,
    async stream(request) {
      const { events } = await model.stream(request)
      return {
        events: (async function* (): AsyncIterable<LanguageModelStreamEvent> {
          for await (const event of events) {
            if (event.type === "finish" && event.reportedCost) {
              charged.push(BigInt(event.reportedCost.money.amountNanos))
            }
            yield event
          }
        })(),
      }
    },
  }
}
