import { afterAll, expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type {
  JsonObject,
  LanguageModel,
  LanguageModelRequest,
  LanguageModelStreamEvent,
  ModelMessage,
} from "@sixb/core/models"
import { prepareAgentModel } from "../../../packages/agent-worker/src/context-budget"
import { agentTraceFromModelSteps } from "../../../packages/agent-worker/src/model-adapters"
import { type AzureAIFoundryOptions, createAzureAIFoundry } from "../src"

// Opt-in: these tests make billable calls. Run sequentially; each call has an output limit,
// a deadline, no automatic retries, and the entire file has a request/output allowance.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1"
const endpoint = env.AZURE_FOUNDRY_PROJECT_ENDPOINT
const apiKey = env.AZURE_FOUNDRY_API_KEY
const fast = env.AZURE_FOUNDRY_FAST_DEPLOYMENT
const reasoning = env.AZURE_FOUNDRY_OPENAI_DEPLOYMENT
const deepseek = env.AZURE_FOUNDRY_DEEPSEEK_DEPLOYMENT
const deepseekReasoning = env.AZURE_FOUNDRY_DEEPSEEK_REASONING_DEPLOYMENT
const claude = env.AZURE_FOUNDRY_CLAUDE_DEPLOYMENT
const glm = env.AZURE_FOUNDRY_GLM_DEPLOYMENT
const live = {
  skipIf: (skip: unknown) => test.skipIf(!enabled || !endpoint || !apiKey || Boolean(skip)),
}
let calls = 0
let reservedOutput = 0
let reportedInput = 0
let reportedOutput = 0
let nextRequestAt = 0

const boundedFetch: NonNullable<AzureAIFoundryOptions["fetch"]> = async (input, init) => {
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
  if (body && typeof body === "object" && "model" in body) {
    const request = body as Record<string, unknown>
    const limit = request.max_output_tokens ?? request.max_completion_tokens ?? request.max_tokens
    if (typeof limit !== "number" || limit <= 0 || limit > 1536)
      throw new Error("Live test requires an output bound of 1–1536 tokens")
    calls++
    reservedOutput += limit
    if (calls > 40 || reservedOutput > 16_000)
      throw new Error("Live test request/output allowance exhausted")
    // Pace small test deployments rather than replaying accepted, potentially billable streams.
    await Bun.sleep(Math.max(0, nextRequestAt - Date.now()))
    init?.signal?.throwIfAborted()
    nextRequestAt = Date.now() + 6_500
  }
  return fetch(input, init)
}

function provider() {
  return createAzureAIFoundry({
    endpoint: endpoint!,
    apiKey,
    maxRetries: 0,
    fetch: boundedFetch,
  })
}

const capabilities = {
  localTools: true,
  nativeStructuredOutput: true,
  inputMediaTypes: ["image/png", "application/pdf"],
}
const schema: JsonObject = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}
function messages(text: string): ModelMessage[] {
  return [{ role: "user", content: [{ type: "text", text }] }]
}
function request(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    callId: `foundry-live-${crypto.randomUUID()}`,
    messages: messages("Reply with exactly: sixb-ok"),
    tools: [],
    maxOutputTokens: 64,
    signal: AbortSignal.timeout(60_000),
    ...overrides,
  }
}
async function collect(model: LanguageModel, input = request()) {
  const events: LanguageModelStreamEvent[] = []
  for await (const event of (await model.stream(input)).events) {
    if (event.type === "error") throw event.error
    events.push(event)
  }
  const finishes = events.filter((event) => event.type === "finish")
  expect(finishes).toHaveLength(1)
  const finish = finishes[0]!
  expect(events.at(-1)?.type).toBe("finish")
  expect(finish.usage.inputTokens).toBeGreaterThan(0)
  expect(finish.usage.outputTokens).toBeGreaterThan(0)
  reportedInput += finish.usage.inputTokens ?? 0
  reportedOutput += finish.usage.outputTokens ?? 0
  console.info("[FoundryLive]", model.modelId, finish.finishReason, JSON.stringify(finish.usage))
  return {
    events,
    finish,
    text: events.flatMap((event) => (event.type === "text-delta" ? [event.delta] : [])).join(""),
  }
}

for (const protocol of ["responses", "chat"] as const) {
  live.skipIf(!fast)(
    `${protocol}: cold worker admission with a context override, text, usage, and strict JSON`,
    async () => {
      const limit = protocol === "responses" ? "contextWindow" : "maxInputTokens"
      const binding = provider()[protocol](fast!, {
        definition: { [limit]: 64000, capabilities },
      })
      const { model, budget } = await prepareAgentModel({ model: binding })
      expect(model.definition[limit]).toBe(64000)
      expect(budget[limit === "contextWindow" ? "windowTokens" : "inputBudgetTokens"]).toBe(64000)
      const result = await collect(
        model,
        request({
          messages: messages('Return JSON with answer equal to "sixb-ok".'),
          responseFormat: { type: "json", name: "answer", schema },
        })
      )
      expect(JSON.parse(result.text)).toEqual({ answer: "sixb-ok" })
      expect(result.finish.finishReason).toBe("stop")
    },
    70_000
  )
}

for (const protocol of ["responses", "chat", "messages"] as const) {
  const deployment = protocol === "messages" ? claude : fast
  live.skipIf(!deployment)(
    `${protocol}: tool execution and durable conversation replay`,
    async () => {
      const model = provider()[protocol](deployment!, { definition: { capabilities } })
      let executions = 0
      const prompt = messages(
        "Call lookup_code once to obtain the secret code, then reply with that code."
      )
      const result = await runModelLoop({
        model,
        messages: prompt,
        signal: AbortSignal.timeout(60_000),
        maxSteps: 2,
        maxOutputTokens: 128,
        tools: [
          {
            name: "lookup_code",
            description: "Get the secret code. Call exactly once.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            parseInput: (input) => input,
            execute: async () => {
              executions++
              return "sixb-739"
            },
            errorText: () => "lookup failed",
          },
        ],
        onModelCallEnd: (event) => {
          reportedInput += event.usage.inputTokens ?? 0
          reportedOutput += event.usage.outputTokens ?? 0
        },
      })
      expect(result.status).toBe("completed")
      expect(executions).toBe(1)
      expect(result.steps).toHaveLength(2)
      const history = toModelMessages([
        {
          role: "assistant",
          parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
        },
      ])
      const replay = await collect(
        model,
        request({
          messages: [
            ...prompt,
            ...history,
            ...messages("What was the secret code? Reply with the code only."),
          ],
        })
      )
      expect(replay.text).toContain("sixb-739")
    },
    140_000
  )
}

live.skipIf(!reasoning)(
  "Responses: encrypted reasoning survives a second turn",
  async () => {
    const model = provider().responses(reasoning!, {
      definition: { capabilities: { reasoning: { efforts: ["low"] } } },
      reasoningSummary: "auto",
    })
    const prompt = messages("What is 17 times 19? Reply with the number only.")
    const result = await runModelLoop({
      model,
      messages: prompt,
      signal: AbortSignal.timeout(60_000),
      maxSteps: 1,
      maxOutputTokens: 768,
      reasoning: "low",
      onModelCallEnd: (event) => {
        reportedInput += event.usage.inputTokens ?? 0
        reportedOutput += event.usage.outputTokens ?? 0
      },
    })
    expect(result.status).toBe("completed")
    const history = toModelMessages([
      {
        role: "assistant",
        parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
      },
    ])
    expect(JSON.stringify(history)).toContain("encrypted_content")
    const replay = await collect(
      model,
      request({
        messages: [
          ...prompt,
          ...history,
          ...messages("Add 1 to that result. Reply with the number only."),
        ],
        maxOutputTokens: 768,
        reasoning: "low",
      })
    )
    expect(replay.text.trim()).toBe("324")
  },
  140_000
)

live.skipIf(!deepseek)(
  "DeepSeek Chat: text, tools and final usage",
  async () => {
    const model = provider().chat(deepseek!, {
      definition: { capabilities: { localTools: true } },
    })
    const result = await collect(
      model,
      request({
        messages: messages(
          "Call lookup_code to get the secret code. Do not answer without calling it."
        ),
        tools: [
          {
            name: "lookup_code",
            description: "Get the secret code; use key 'secret'",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string" } },
              required: ["key"],
              additionalProperties: false,
            },
          },
        ],
        maxOutputTokens: 128,
      })
    )
    expect(result.events.some((event) => event.type === "tool-call")).toBe(true)
    expect(result.finish.finishReason).toBe("tool-calls")
    const call = result.events.find((event) => event.type === "tool-call")!
    expect(JSON.parse(call.input)).toMatchObject({ key: "secret" })
    const reply = await collect(
      model,
      request({
        messages: [
          ...messages("Call lookup_code to get the secret code, then reply with the result."),
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                input: JSON.parse(call.input),
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: { type: "text", value: "sixb-739" },
              },
            ],
          },
        ],
      })
    )
    expect(reply.text).toContain("sixb-739")
  },
  70_000
)

for (const protocol of ["responses", "chat", "messages"] as const) {
  const deployment = protocol === "messages" ? claude : fast
  live.skipIf(!deployment)(
    `${protocol}: inline image reaches vision input`,
    async () => {
      // A 64×64 solid-red PNG, generated locally; no network image dependency.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nO3RwQkAMAwDMe+/dDtEH6Jw4AES3c729fwFPaAJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJKzCv+LILqdzw4i4ZAl4AAAAASUVORK5CYII="
      const model = provider()[protocol](deployment!, { definition: { capabilities } })
      const image = await new Bun.Image(Buffer.from(png, "base64")).resize(256, 256).png().bytes()
      const result = await collect(
        model,
        request({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What color is this image? Reply with one word." },
                {
                  type: "file",
                  mediaType: "image/png",
                  data: new URL(`data:image/png;base64,${Buffer.from(image).toString("base64")}`),
                },
              ],
            },
          ],
        })
      )
      expect(result.text.toLowerCase()).toContain("red")
    },
    70_000
  )
}

live.skipIf(!fast)(
  "Responses: structured output is validated by the model loop",
  async () => {
    const result = await runModelLoop({
      model: provider().responses(fast!, {
        definition: { capabilities },
        request: { temperature: 0 },
      }),
      messages: messages(
        'Return exactly one JSON object with answer equal to "sixb-ok". Do not repeat it.'
      ),
      maxSteps: 1,
      maxOutputTokens: 64,
      signal: AbortSignal.timeout(60_000),
      output: {
        name: "answer",
        schema,
        validate: (value) => {
          expect(value).toEqual({ answer: "sixb-ok" })
          return value
        },
      },
      onModelCallEnd: (event) => {
        reportedInput += event.usage.inputTokens ?? 0
        reportedOutput += event.usage.outputTokens ?? 0
      },
    })
    if (result.status !== "completed") throw new Error("Structured output did not complete")
    expect(result.output).toEqual({ answer: "sixb-ok" })
  },
  70_000
)

live.skipIf(!fast)(
  "Responses: repeated prefix retains cache accounting and explicit local prices",
  async () => {
    const model = provider().responses(fast!, {
      // Synthetic rates verify the accounting path, not Azure's actual invoice.
      rateCard: {
        currency: "USD",
        unit: "million-tokens",
        input: "1",
        output: "2",
        cacheReadInput: "0.5",
      },
    })
    const prefix = Array.from(
      { length: 100 },
      (_, i) => `Record ${i}: the test document describes a small green tree.`
    ).join("\n")
    for (let i = 0; i < 2; i++) {
      const result = await collect(
        model,
        request({ messages: messages(`${prefix}\nReply with exactly: OK`) })
      )
      expect(result.text.trim()).toBe("OK")
      expect(result.finish.usage.cacheReadInputTokens).toBeGreaterThanOrEqual(0)
      expect(model.costEstimator?.estimate({ usage: result.finish.usage })).toMatchObject({
        status: "rated",
      })
    }
  },
  140_000
)

live.skipIf(!endpoint || !fast)(
  "API key: project discovery, protocol views, pinned resolution and inference",
  async () => {
    const foundry = createAzureAIFoundry({
      endpoint: endpoint!,
      apiKey: apiKey!,
      maxRetries: 0,
      fetch: boundedFetch,
      discovery: { timeoutMs: 30_000 },
    })
    const [records, chat] = await Promise.all([
      foundry.catalog.deployments(),
      foundry.catalog.list({ protocol: "chat" }),
    ])
    expect(records.some((record) => record.name === fast)).toBe(true)
    expect(chat.some((model) => model.modelId === fast)).toBe(true)
    const model = await foundry.responses(fast!).resolve()
    expect(model.metadata.publisher).toBe("OpenAI")
    expect(await model.resolve()).toBe(model)
    const offline = await foundry.responses(fast!).resolve({ offline: true })
    expect(offline.metadata).toEqual(model.metadata)
    expect((await collect(model)).text).toContain("sixb-ok")
  },
  100_000
)

live.skipIf(!fast)(
  "Responses: tiny inline PDF is read by the model",
  async () => {
    const model = provider().responses(fast!, { definition: { capabilities } })
    const result = await collect(
      model,
      request({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What is the secret code printed in this PDF? Reply with the code only.",
              },
              {
                type: "file",
                mediaType: "application/pdf",
                data: new URL(`data:application/pdf;base64,${pdf()}`),
              },
            ],
          },
        ],
      })
    )
    expect(result.text).toContain("sixb-482")
  },
  70_000
)

live.skipIf(!fast)(
  "Responses: output limit is reported as truncation with usage",
  async () => {
    const result = await collect(
      provider().responses(fast!),
      request({
        messages: messages("Write a detailed paragraph of at least 200 words about the ocean."),
        maxOutputTokens: 16,
      })
    )
    expect(result.finish.finishReason).toBe("length")
    expect(result.finish.usage.outputTokens).toBeLessThanOrEqual(16)
  },
  70_000
)

live.skipIf(!fast)(
  "Responses: active stream can be cancelled",
  async () => {
    const controller = new AbortController()
    const model = provider().responses(fast!)
    let sawText = false
    const consume = async () => {
      const response = await model.stream(
        request({
          messages: messages("Count from 1 to 100."),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
          maxOutputTokens: 128,
        })
      )
      for await (const event of response.events) {
        if (event.type === "error") throw event.error
        if (event.type === "text-delta") {
          sawText = true
          controller.abort(new Error("Live test cancellation"))
        }
      }
    }
    await expect(consume()).rejects.toThrow("Live test cancellation")
    expect(sawText).toBe(true)
  },
  40_000
)

live.skipIf(false)(
  "missing deployment fails during resolution before inference",
  async () => {
    await expect(
      provider().responses("sixb-nonexistent-e2e-deployment").stream(request())
    ).rejects.toThrow("was not found in this project")
  },
  70_000
)

live.skipIf(!deepseekReasoning)(
  "DeepSeek V4 Chat: reasoning and tool-continuation replay",
  async () => {
    const model = provider().chat(deepseekReasoning!, {
      definition: { capabilities: { localTools: true, reasoning: { efforts: ["low"] } } },
      reasoningReplay: "tool-continuation",
      profile: "deepseek",
    })
    let executions = 0
    const result = await runModelLoop({
      model,
      messages: messages("Use lookup_code with key 'secret', then answer with the returned code."),
      maxSteps: 2,
      maxOutputTokens: 768,
      reasoning: "low",
      signal: AbortSignal.timeout(90_000),
      tools: [
        {
          name: "lookup_code",
          description: "Get the secret code",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
          parseInput: (input) => {
            expect(input).toEqual({ key: "secret" })
            return input
          },
          execute: async () => {
            executions++
            return "sixb-739"
          },
          errorText: () => "lookup failed",
        },
      ],
      onModelCallEnd: (event) => {
        reportedInput += event.usage.inputTokens ?? 0
        reportedOutput += event.usage.outputTokens ?? 0
      },
    })
    expect(result.status).toBe("completed")
    expect(executions).toBe(1)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]?.content.some((part) => part.type === "reasoning")).toBe(true)
    expect(JSON.stringify(result.steps[1]?.content)).toContain("sixb-739")
    expect(JSON.stringify(result.steps[0]?.content)).toContain("reasoning_content")
  },
  100_000
)

live.skipIf(!reasoning)(
  "OpenAI Chat: named reasoning effort and output usage",
  async () => {
    const model = provider().chat(reasoning!, {
      definition: { capabilities: { reasoning: { efforts: ["low"] } } },
    })
    const result = await collect(
      model,
      request({
        messages: messages("What is 17 times 19? Reply with the number only."),
        reasoning: "low",
        maxOutputTokens: 768,
      })
    )
    expect(result.text.trim()).toBe("323")
    expect(result.finish.usage.reasoningOutputTokens).toBeGreaterThanOrEqual(0)
  },
  70_000
)

live.skipIf(!glm)(
  "GLM Chat: text, reasoning separation and usage",
  async () => {
    const result = await collect(provider().chat(glm!), request({ maxOutputTokens: 512 }))
    expect(result.text).toContain("sixb-ok")
    expect(result.finish.finishReason).toBe("stop")
    expect(result.text).not.toContain("<think>")
  },
  70_000
)

live.skipIf(!glm)(
  "GLM Chat: explicit strict structured output",
  async () => {
    const model = provider().chat(glm!, {
      definition: { capabilities: { nativeStructuredOutput: true } },
    })
    const result = await collect(
      model,
      request({
        messages: messages('Return exactly one JSON object with answer equal to "sixb-ok".'),
        responseFormat: { type: "json", name: "answer", schema },
        maxOutputTokens: 768,
      })
    )
    expect(JSON.parse(result.text)).toEqual({ answer: "sixb-ok" })
  },
  70_000
)

live.skipIf(!glm || !endpoint)(
  "GLM Responses: project routing without encrypted replay",
  async () => {
    const result = await collect(
      provider().responses(glm!, { encryptedReasoning: false }),
      request({ maxOutputTokens: 512 })
    )
    expect(result.text).toContain("sixb-ok")
    expect(result.finish.finishReason).toBe("stop")
  },
  70_000
)

live.skipIf(!glm)(
  "GLM Chat: model-loop tool execution",
  async () => {
    const model = provider().chat(glm!, { definition: { capabilities: { localTools: true } } })
    let executions = 0
    const result = await runModelLoop({
      model,
      messages: messages("Call lookup_code with key 'secret', then answer with the returned code."),
      maxSteps: 2,
      maxOutputTokens: 768,
      signal: AbortSignal.timeout(90_000),
      tools: [
        {
          name: "lookup_code",
          description: "Get the secret code",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
          parseInput: (input) => {
            expect(input).toEqual({ key: "secret" })
            return input
          },
          execute: async () => {
            executions++
            return "sixb-739"
          },
          errorText: () => "lookup failed",
        },
      ],
      onModelCallEnd: (event) => {
        reportedInput += event.usage.inputTokens ?? 0
        reportedOutput += event.usage.outputTokens ?? 0
      },
    })
    expect(result.status).toBe("completed")
    expect(executions).toBe(1)
    expect(result.steps).toHaveLength(2)
    expect(JSON.stringify(result.steps[1]?.content)).toContain("sixb-739")
  },
  100_000
)

// A real one-page PDF with a cross-reference table; no PDF library or external URL is needed.
function pdf(): string {
  const text = "BT /F1 18 Tf 30 100 Td (Secret code: sixb-482) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ]
  let file = "%PDF-1.4\n"
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(file.length)
    file += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = file.length
  file += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(file).toString("base64")
}

afterAll(() => {
  if (enabled)
    console.info("[FoundryLive] Totals", {
      calls,
      reservedOutput,
      reportedInput,
      reportedOutput,
      note: "Cancelled/error calls may have unreported billable usage; this is not an invoice.",
    })
})
