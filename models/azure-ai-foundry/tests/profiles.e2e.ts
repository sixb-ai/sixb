import { expect, test } from "bun:test"
import type { LanguageModelStreamEvent } from "@sixb/core/models"
import { createAzureAIFoundry } from "../src"
import { object } from "../src/util"

// Opt-in, maximum eight billable attempts / 4,096 requested output tokens, no retries.
// Verifies credentials + deployment + resource region, with no caller-supplied model facts/rates.
const env = process.env
const names = [
  env.AZURE_FOUNDRY_GLM_53_DEPLOYMENT,
  env.AZURE_FOUNDRY_KIMI_K3_DEPLOYMENT,
  env.AZURE_FOUNDRY_DEEPSEEK_V4_FLASH_DEPLOYMENT,
  env.AZURE_FOUNDRY_FAST_DEPLOYMENT,
  env.AZURE_FOUNDRY_OPENAI_DEPLOYMENT,
  env.AZURE_FOUNDRY_DEEPSEEK_DEPLOYMENT,
  env.AZURE_FOUNDRY_DEEPSEEK_REASONING_DEPLOYMENT,
  env.AZURE_FOUNDRY_GLM_DEPLOYMENT,
].filter((name): name is string => Boolean(name))
test.skipIf(
  env.SIXB_FOUNDRY_E2E !== "1" ||
    env.SIXB_FOUNDRY_E2E_ENTRA !== "1" ||
    !env.AZURE_FOUNDRY_PROJECT_ENDPOINT ||
    !names.length
)(
  "resolves live deployment identities, selects protocols and automatically prices supported usage",
  async () => {
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
    let attempts = 0
    let outputAllowance = 0
    const provider = createAzureAIFoundry({
      endpoint: env.AZURE_FOUNDRY_PROJECT_ENDPOINT!,
      tokenProvider: () => token,
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
    for (const name of names) {
      if (attempts) await Bun.sleep(13500)
      try {
        const model = await provider(name).resolve()
        const reasoning = model.definition.capabilities.reasoning
        const effort = reasoning ? reasoning.efforts?.[0] : undefined
        if (model.metadata.catalog) expect(model.definition.contextWindow).toBeGreaterThan(0)
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
        for await (const event of (await model.stream(request)).events) {
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
        else if (model.metadata.catalog) expect(cost.status).toBe("rated")
        else expect(cost.status).toBe("unpriceable")
        inputTokens += finish.usage.inputTokens ?? 0
        outputTokens += finish.usage.outputTokens ?? 0
      } catch (error) {
        errors.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`))
      }
    }
    expect(attempts).toBe(names.length)
    console.info(
      "[FoundryProfileLive]",
      JSON.stringify({ attempts, outputAllowance, inputTokens, outputTokens })
    )
    if (errors.length) throw new AggregateError(errors, "Foundry live model checks failed")
  },
  660000
)
