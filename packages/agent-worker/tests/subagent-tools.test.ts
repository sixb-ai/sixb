import { describe, expect, test } from "bun:test"
import { createModelCatalog } from "@sixb/core/models"
import { renderSubagentModelGuide } from "../src/subagent-tools"
import { WorkerTestModel } from "./worker-model-fixture"

describe("subagent model guidance", () => {
  test("reads each model's configured definition and never its provider catalog", () => {
    // Removal proof: render from `await entry.model.resolve()` again; the bad catalog body fails
    // the guide, so it would fail every turn.
    const model = new WorkerTestModel({
      definition: {
        kind: "language",
        providerId: "gateway",
        modelId: "openai/gpt-5.5",
        name: "GPT",
        capabilities: { localTools: true },
      },
    })
    let resolutions = 0
    const catalog = createModelCatalog({
      language: [
        {
          ...model,
          stream: (request) => model.stream(request),
          resolve: async () => {
            resolutions += 1
            throw new Error("Gateway returned an invalid model catalog body.")
          },
        },
      ],
    })

    expect(renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway","modelId":"openai/gpt-5.5"} GPT (default; tools)',
      ].join("\n")
    )
    expect(resolutions).toBe(0)
  })

  test("lists each model by its exact reference with provider-declared metadata only", () => {
    // The default declares nothing; the other model's slash-joined label would equal its own.
    const catalog = createModelCatalog({
      language: [
        new WorkerTestModel({
          definition: {
            kind: "language",
            providerId: "gateway/private",
            modelId: "specialist",
            capabilities: {},
          },
        }),
        new WorkerTestModel({
          definition: {
            kind: "language",
            providerId: "gateway",
            modelId: "private/specialist",
            contextWindow: 400_000,
            capabilities: { reasoning: { efforts: ["high"] }, localTools: true },
          },
        }),
      ],
    })
    expect(renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway/private","modelId":"specialist"} (default; metadata unavailable)',
        '- {"provider":"gateway","modelId":"private/specialist"} (context 400k tokens; reasoning; tools)',
      ].join("\n")
    )
  })

  test("gives each model its name and description on one line", () => {
    // Removal proof: drop the name and description from the model's line.
    const catalog = createModelCatalog({
      language: [
        new WorkerTestModel({
          definition: {
            kind: "language",
            providerId: "gateway",
            modelId: "openai/gpt-5.5",
            name: "GPT",
            description: "A second opinion,\nuseful to compare an analysis.",
            capabilities: { localTools: true },
          },
        }),
      ],
    })

    expect(renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway","modelId":"openai/gpt-5.5"} GPT (default; tools): A second opinion, useful to compare an analysis.',
      ].join("\n")
    )
  })

  test("groups tiered models by tier and says how to choose between them", () => {
    // Removal proof: render a tiered entry as a list line, or keep the list's heading and advice.
    const model = (modelId: string, name: string, description?: string) =>
      new WorkerTestModel({
        definition: {
          kind: "language",
          providerId: "gateway",
          modelId,
          name,
          ...(description === undefined ? {} : { description }),
          capabilities: { reasoning: { efforts: ["high"] } },
        },
      })
    const catalog = createModelCatalog({
      language: {
        heavy: [
          model("anthropic/claude-opus-5.5", "Claude Opus 5.5"),
          model("openai/gpt-5.5", "GPT", "A second opinion, useful to compare an analysis."),
        ],
        standard: model("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"),
        light: model("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
      },
    })

    expect(renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Models you can delegate to:",
        'light     {"provider":"gateway","modelId":"deepseek/deepseek-v4.1-flash"} DeepSeek V4.1 Flash (reasoning)',
        'standard  {"provider":"gateway","modelId":"anthropic/claude-sonnet-5.5"} Claude Sonnet 5.5 (default; reasoning)',
        'heavy     {"provider":"gateway","modelId":"anthropic/claude-opus-5.5"} Claude Opus 5.5 (reasoning)',
        'heavy     {"provider":"gateway","modelId":"openai/gpt-5.5"} GPT (reasoning): A second opinion, useful to compare an analysis.',
        "Tiers rank cost and strength: light is the cheapest and fastest, heavy the strongest.",
        'Use a tier by default (model: "light" | "standard" | "heavy"). Use a specific model when its description fits the task.',
      ].join("\n")
    )
  })
})
