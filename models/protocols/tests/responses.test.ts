import { expect, test } from "bun:test"
import type { JsonObject, ModelAssistantPart } from "@sixb/core/models"
import { responsesEvents, responsesInput, responsesUsage } from "../src/responses"

function stream(events: readonly JsonObject[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  )
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}

// Regression proof: remove the providerId checks in responses/input.ts. Foreign encrypted
// state then enters the request and this test fails. No Azure/Gateway credentials are involved.
test("round-trips encrypted reasoning and phases under independent provider identities", async () => {
  for (const providerId of ["first", "second"]) {
    const reasoning = {
      type: "reasoning",
      id: "reason",
      encrypted_content: "opaque",
      summary: [{ type: "summary_text", text: "réfléchir" }],
    }
    const content: ModelAssistantPart[] = []
    let textProviderData: Extract<ModelAssistantPart, { type: "text" }>["providerData"]
    let visible = ""
    const events = []
    for await (const event of responsesEvents(
      stream([
        { type: "response.created", response: { id: "resp", model: "deployment" } },
        { type: "response.output_item.done", item: reasoning },
        { type: "response.output_text.delta", item_id: "message", delta: "Voilà" },
        { type: "response.output_text.done", item_id: "message", text: "Voilà" },
        {
          type: "response.output_item.done",
          item: { type: "message", id: "message", phase: "commentary" },
        },
        {
          type: "response.completed",
          response: {
            id: "resp",
            status: "completed",
            output: [reasoning],
            usage: { input_tokens: 10, output_tokens: 5 },
            gateway: { cost: "99", provider: "must-not-be-interpreted" },
          },
        },
      ]),
      new AbortController().signal,
      {
        providerId,
        modelId: "deployment",
        requestId: "request",
        errorPrefix: "[TestProvider]",
      }
    )) {
      events.push(event)
      if (event.type === "provider-state") content.push(event)
      if (event.type === "text-start") textProviderData = event.providerData
      if (event.type === "text-delta") visible += event.delta
      if (event.type === "text-end")
        content.push({ type: "text", text: visible, providerData: textProviderData })
    }
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason:reasoning:0", delta: "réfléchir" },
    ])
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 5, raw: { input_tokens: 10, output_tokens: 5 } },
    })
    expect(events.filter((event) => event.type === "response-metadata").at(-1)).toEqual({
      type: "response-metadata",
      providerIds: { requestId: "request", responseId: "resp" },
    })
    content.push({
      type: "provider-state",
      providerId: "foreign",
      data: { item: { type: "reasoning", encrypted_content: "foreign" } },
    })
    // Durable histories serialize opaque content; no module identity or in-memory state is needed.
    const replay: ModelAssistantPart[] = JSON.parse(JSON.stringify(content))
    expect(responsesInput([{ role: "assistant", content: replay }], providerId)).toEqual([
      reasoning,
      { role: "assistant", content: [{ type: "output_text", text: "Voilà" }], phase: "commentary" },
    ])
  }
})

test("preserves reported counters without importing a provider's missing-usage assumptions", () => {
  expect(responsesUsage(undefined)).toEqual({})
  const raw = {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  }
  expect(responsesUsage(raw)).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: 2,
    raw,
  })
  expect(responsesUsage({ input_tokens: -1, output_tokens: 1.5 })).toEqual({
    raw: { input_tokens: -1, output_tokens: 1.5 },
  })
})

test("rejects an unterminated stream with the calling provider's diagnostic identity", async () => {
  const consume = async () => {
    for await (const _event of responsesEvents(
      stream([{ type: "response.output_text.delta", item_id: "message", delta: "partial" }]),
      new AbortController().signal,
      {
        providerId: "independent",
        modelId: "deployment",
        requestId: "request",
        errorPrefix: "[Independent]",
      }
    )) {
      /* consume to EOF */
    }
  }
  await expect(consume()).rejects.toMatchObject({
    name: "ModelProviderError",
    providerId: "independent",
    modelId: "deployment",
    requestId: "request",
    message: "[Independent] Provider stream ended without a terminal response event.",
  })
})
