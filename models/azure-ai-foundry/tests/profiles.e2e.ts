import { expect, test } from "bun:test"
import { resolveLanguageModel } from "@sixb/core/internal/model-execution"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { createAzureAIFoundry } from "../src"
import { object } from "../src/util"

// Opt-in, maximum eight billable attempts / 4,096 requested output tokens, no retries.
// Verifies credentials + deployment + resource region, with no caller-supplied model facts/rates.
const env = process.env
// These environment variables designate specific model fixtures, not arbitrary deployments.
const fixtures = [
  {
    name: env.AZURE_FOUNDRY_GLM_53_DEPLOYMENT,
    model: "FW-GLM-5.3",
    provider: "fireworks-ai",
    id: "accounts/fireworks/models/glm-5p3",
    tools: true,
    reasoning: true,
    images: false,
  },
  {
    name: env.AZURE_FOUNDRY_KIMI_K3_DEPLOYMENT,
    model: "FW-Kimi-K3",
    provider: "fireworks-ai",
    id: "accounts/fireworks/models/kimi-k3",
    tools: true,
    reasoning: true,
    images: true,
  },
  {
    name: env.AZURE_FOUNDRY_DEEPSEEK_V4_FLASH_DEPLOYMENT,
    model: "FW-DeepSeek-V4-Flash-0731",
    provider: "fireworks-ai",
    id: "accounts/fireworks/models/deepseek-v4-flash-0731",
    tools: true,
    reasoning: true,
    images: false,
  },
  {
    name: env.AZURE_FOUNDRY_FAST_DEPLOYMENT,
    model: "gpt-4.1-mini",
    provider: "azure",
    id: "gpt-4.1-mini",
    tools: true,
    reasoning: false,
    images: true,
  },
  {
    name: env.AZURE_FOUNDRY_OPENAI_DEPLOYMENT,
    model: "gpt-5-mini",
    provider: "azure",
    id: "gpt-5-mini",
    tools: true,
    reasoning: true,
    images: true,
  },
  {
    name: env.AZURE_FOUNDRY_DEEPSEEK_DEPLOYMENT,
    model: "DeepSeek-V3.2",
    provider: "azure",
    id: "deepseek-v3.2",
    tools: true,
    reasoning: true,
    images: false,
  },
  {
    name: env.AZURE_FOUNDRY_DEEPSEEK_REASONING_DEPLOYMENT,
    model: "DeepSeek-V4-Pro",
    provider: "azure",
    id: "deepseek-v4-pro",
    tools: false,
    reasoning: true,
    images: false,
  },
  {
    name: env.AZURE_FOUNDRY_GLM_DEPLOYMENT,
    model: "FW-GLM-5.2-Fast",
    provider: "fireworks-ai",
    id: "accounts/fireworks/routers/glm-5p2-fast",
    tools: true,
    reasoning: true,
    images: false,
  },
].flatMap((fixture) => (fixture.name ? [{ ...fixture, name: fixture.name }] : []))
// Regression proof: return undefined from RemoteModelsDevCatalog.get(). These checks
// must fail before inference; unknown-model behavior has separate deterministic coverage.

test.skipIf(
  env.SIXB_FOUNDRY_E2E !== "1" ||
    !env.AZURE_FOUNDRY_API_KEY ||
    !env.AZURE_FOUNDRY_PROJECT_ENDPOINT ||
    !fixtures.length
)(
  "resolves live deployment identities, selects protocols and automatically prices supported usage",
  async () => {
    let attempts = 0
    let outputAllowance = 0
    const provider = createAzureAIFoundry({
      endpoint: env.AZURE_FOUNDRY_PROJECT_ENDPOINT!,
      apiKey: env.AZURE_FOUNDRY_API_KEY!,
      maxRetries: 0,
      fetch: async (url, init) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body))
          const ceiling = body.max_output_tokens ?? body.max_completion_tokens
          expect(Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling <= 512).toBe(true)
          expect(++attempts).toBeLessThanOrEqual(8)
          outputAllowance += ceiling
          expect(outputAllowance).toBeLessThanOrEqual(4096)
        }
        return fetch(url, init)
      },
    })
    let inputTokens = 0
    let outputTokens = 0
    const errors: Error[] = []
    for (const fixture of fixtures) {
      const { name } = fixture
      if (attempts) await Bun.sleep(13500)
      try {
        const binding = provider(name)
        const executable = await resolveLanguageModel(binding)
        const model = await binding.resolve({ offline: true })
        expect(executable.definition).toEqual(model.definition)
        expect(model.metadata).toMatchObject({
          modelName: fixture.model,
          deployment: { name },
          catalog: { provider: fixture.provider, modelId: fixture.id, pricing: "reference" },
        })
        expect(model.protocol).toBe("chat")
        expect(model.definition.contextWindow).toBeGreaterThan(0)
        expect(model.definition.maxOutputTokens).toBeGreaterThan(0)
        expect(model.definition.capabilities.localTools).toBe(fixture.tools)
        expect(Boolean(model.definition.capabilities.reasoning)).toBe(fixture.reasoning)
        expect(model.definition.capabilities.inputMediaTypes?.includes("image/png")).toBe(
          fixture.images
        )
        // Prove reference rates exist even if the live response has an unknown usage meter.
        expect(
          model.costEstimator.estimate({
            usage: {
              inputTokens: 10,
              uncachedInputTokens: 10,
              cacheReadInputTokens: 0,
              outputTokens: 2,
            },
            responseModelId: fixture.model,
          })
        ).toMatchObject({ status: "rated" })
        const reasoning = model.definition.capabilities.reasoning
        const effort = reasoning ? reasoning.efforts?.[0] : undefined
        const events: LanguageModelStreamEvent[] = []
        const request = {
          callId: `profile-live-${crypto.randomUUID()}`,
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "Reply with exactly: sixb-ok" }],
            },
          ],
          tools: [],
          maxOutputTokens: name === env.AZURE_FOUNDRY_FAST_DEPLOYMENT ? 128 : 512,
          signal: AbortSignal.timeout(60000),
          ...(effort ? { reasoning: effort } : {}),
        }
        for await (const event of (await executable.stream(request)).events) {
          if (event.type === "error") throw event.error
          events.push(event)
        }
        const finish = events.find((e) => e.type === "finish")
        expect(finish).toBeDefined()
        if (!finish) throw new Error("Missing finish")
        expect(finish.usage.inputTokens).toBeGreaterThan(0)
        expect(finish.usage.outputTokens).toBeGreaterThan(0)
        const metadata = events.find((e) => e.type === "response-metadata")
        const cost = model.costEstimator.estimate({
          usage: finish.usage,
          responseModelId: metadata?.modelId,
          route: finish.route,
        })
        console.info(
          "[FoundryProfileLive]",
          name,
          model.protocol,
          JSON.stringify({ usage: finish.usage, cost, catalog: model.metadata.catalog })
        )
        // A catalog match doesn't make a null auxiliary usage meter a known zero.
        const nullAudio = object(finish.usage.raw?.prompt_tokens_details)?.audio_tokens === null
        if (nullAudio)
          expect(cost).toMatchObject({ status: "unpriceable", reason: "missing-rate-card" })
        else expect(cost.status).toBe("rated")
        inputTokens += finish.usage.inputTokens ?? 0
        outputTokens += finish.usage.outputTokens ?? 0
      } catch (error) {
        errors.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    console.info(
      "[FoundryProfileLive]",
      JSON.stringify({ attempts, outputAllowance, inputTokens, outputTokens })
    )
    if (errors.length) throw new AggregateError(errors, "Foundry live model checks failed")
    expect(attempts).toBe(fixtures.length)
  },
  660000
)
