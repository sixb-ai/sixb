import { afterAll, beforeAll, expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type { ModelMessage } from "@sixb/core/models"
import { agentTraceFromModelSteps } from "../../../packages/agent-worker/src/model-adapters"
import { type AzureAIFoundryProvider, createAzureAIFoundry } from "../src"

// Opt-in: up to 16 attempts / 16,384 requested output tokens, serial, no retries.
// Exercises multiple tools, optional multiple images, durable history and strict JSON
// on discovered bindings. Fixture tests remain responsible for deterministic failures.
const env = process.env
const enabled = env.SIXB_FOUNDRY_E2E === "1" && env.SIXB_FOUNDRY_E2E_ENTRA === "1"
const names = [
  env.AZURE_FOUNDRY_GLM_53_DEPLOYMENT,
  env.AZURE_FOUNDRY_KIMI_K3_DEPLOYMENT,
  env.AZURE_FOUNDRY_DEEPSEEK_V4_FLASH_DEPLOYMENT,
  env.AZURE_FOUNDRY_FAST_DEPLOYMENT,
].filter((name): name is string => Boolean(name))
let provider: AzureAIFoundryProvider
let attempts = 0
let allowance = 0
let nextAt = 0
let inputTokens = 0
let outputTokens = 0

beforeAll(async () => {
  if (!enabled || !env.AZURE_FOUNDRY_PROJECT_ENDPOINT || !names.length) return
  const child = Bun.spawn(
    ["az", "account", "get-access-token", "--resource", "https://ai.azure.com", "-o", "json"],
    { stdout: "pipe", stderr: "pipe" }
  )
  const timer = setTimeout(() => child.kill(), 30000)
  let token: string
  try {
    const result = JSON.parse(await new Response(child.stdout).text())
    expect(await child.exited).toBe(0)
    expect(typeof result.accessToken).toBe("string")
    token = result.accessToken
  } finally {
    clearTimeout(timer)
  }
  provider = createAzureAIFoundry({
    endpoint: env.AZURE_FOUNDRY_PROJECT_ENDPOINT,
    tokenProvider: () => token,
    maxRetries: 0,
    fetch: async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        const ceiling = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens
        expect(Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling <= 1024).toBe(true)
        expect(++attempts).toBeLessThanOrEqual(16)
        allowance += ceiling
        expect(allowance).toBeLessThanOrEqual(16384)
        await Bun.sleep(Math.max(0, nextAt - Date.now()))
        init.signal?.throwIfAborted()
        nextAt = Date.now() + 13500
      }
      return fetch(url, init)
    },
  })
}, 35000)

afterAll(() => {
  if (attempts)
    console.info(
      "[FoundryContractLive]",
      JSON.stringify({ attempts, allowance, inputTokens, outputTokens })
    )
})

for (const name of names) {
  test.skipIf(!enabled || !env.AZURE_FOUNDRY_PROJECT_ENDPOINT)(
    `${name}: multiple tools, supported images, durable replay and reference accounting`,
    async () => {
      const model = await provider(name).resolve()
      expect(model.definition.capabilities.localTools).toBe(true)
      const reasoningCaps = model.definition.capabilities.reasoning
      const reasoning = reasoningCaps ? reasoningCaps.efforts?.[0] : undefined
      const images = model.definition.capabilities.inputMediaTypes?.includes("image/png") === true
      const content: Extract<ModelMessage, { role: "user" }>["content"][number][] = [
        {
          type: "text",
          text:
            "Use lookup_code for both alpha and beta. Call it once for each key. Reply with both returned codes." +
            (images ? " Also report the color of both attached images." : ""),
        },
      ]
      if (images) {
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nO3RwQkAMAwDMe+/dDtEH6Jw4AES3c729fwFPaAJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJK6AJKzCv+LILqdzw4i4ZAl4AAAAASUVORK5CYII="
        const image = await new Bun.Image(Buffer.from(png, "base64")).resize(256, 256).png().bytes()
        for (let i = 0; i < 2; i++)
          content.push({
            type: "file",
            mediaType: "image/png",
            data: new URL(`data:image/png;base64,${Buffer.from(image).toString("base64")}`),
          })
      }
      const prompt: ModelMessage[] = [{ role: "user", content }]
      const executed: string[] = []
      const result = await runModelLoop({
        model,
        messages: prompt,
        reasoning,
        maxSteps: 3,
        maxOutputTokens: 1024,
        signal: AbortSignal.timeout(150000),
        tools: [
          {
            name: "lookup_code",
            description: "Get the secret code for alpha or beta.",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string", enum: ["alpha", "beta"] } },
              required: ["key"],
              additionalProperties: false,
            },
            parseInput: (input) => {
              if (
                !input ||
                typeof input !== "object" ||
                !("key" in input) ||
                (input.key !== "alpha" && input.key !== "beta")
              )
                throw new Error("Invalid lookup key")
              return input.key
            },
            execute: async (key) => {
              if (key !== "alpha" && key !== "beta") throw new Error("Invalid lookup key")
              executed.push(key)
              return key === "alpha" ? "sixb-739" : "sixb-482"
            },
            errorText: () => "Invalid lookup key",
          },
        ],
        onModelCallEnd: (event) => {
          inputTokens += event.usage.inputTokens ?? 0
          outputTokens += event.usage.outputTokens ?? 0
        },
      })
      console.info(
        "[FoundryContractLive]",
        name,
        JSON.stringify({
          status: result.status,
          images,
          executed,
          steps: result.steps.map((step) => ({
            finish: step.finishReason,
            usage: step.usage,
            cost: step.cost,
          })),
        })
      )
      expect(result.status).toBe("completed")
      expect(executed.sort()).toEqual(["alpha", "beta"])
      const text =
        result.steps
          .at(-1)
          ?.content.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") ?? ""
      expect(text).toContain("sixb-739")
      expect(text).toContain("sixb-482")
      if (images) expect(text.toLowerCase()).toContain("red")
      for (const step of result.steps) expect(step.cost?.status).toBe("rated")

      const history = toModelMessages([
        {
          role: "assistant",
          parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
        },
      ])
      const structured = model.definition.capabilities.nativeStructuredOutput === true
      let reply = ""
      let finished = false
      for await (const event of (
        await model.stream({
          callId: crypto.randomUUID(),
          messages: [
            ...prompt,
            ...history,
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'Return the two codes from our conversation as JSON with keys "alpha" and "beta". No tools.',
                },
              ],
            },
          ],
          tools: [],
          reasoning,
          maxOutputTokens: 1024,
          signal: AbortSignal.timeout(90000),
          ...(structured
            ? {
                responseFormat: {
                  type: "json" as const,
                  name: "codes",
                  schema: {
                    type: "object",
                    properties: { alpha: { type: "string" }, beta: { type: "string" } },
                    required: ["alpha", "beta"],
                    additionalProperties: false,
                  },
                },
              }
            : {}),
        })
      ).events) {
        if (event.type === "error") throw event.error
        if (event.type === "text-delta") reply += event.delta
        if (event.type === "finish") {
          expect(finished).toBe(false)
          finished = true
          inputTokens += event.usage.inputTokens ?? 0
          outputTokens += event.usage.outputTokens ?? 0
          expect(event.finishReason).toBe("stop")
          expect(
            model.costEstimator.estimate({ usage: event.usage, route: event.route }).status
          ).toBe("rated")
        }
      }
      expect(finished).toBe(true)
      if (structured) expect(JSON.parse(reply)).toEqual({ alpha: "sixb-739", beta: "sixb-482" })
      else {
        expect(reply).toContain("sixb-739")
        expect(reply).toContain("sixb-482")
      }
      console.info(
        "[FoundryContractLive]",
        name,
        JSON.stringify({ replay: "passed", strictSchema: structured })
      )
    },
    250000
  )
}
