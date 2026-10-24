import { describe, expect, spyOn, test } from "bun:test"
import { createModelCatalog, ModelCatalogUnavailableError } from "@sixb/core/models"
import { renderSubagentModelGuide } from "../src/subagent-tools"
import { WorkerTestModel } from "./worker-model-fixture"

describe("subagent model guidance", () => {
  test("uses resolved provider metadata and falls back only when its catalog is unavailable", async () => {
    // Removal proof: use only entry.model.definition; the resolved context limit is lost.
    const model = new WorkerTestModel({ providerId: "private", modelId: "specialist" })
    let unavailable = false
    const catalog = createModelCatalog({
      language: [
        {
          ...model,
          stream: (request) => model.stream(request),
          resolve: async () => {
            if (unavailable) throw new ModelCatalogUnavailableError("offline")
            return new WorkerTestModel({
              definition: { ...model.definition, contextWindow: 256_000 },
            })
          },
        },
      ],
    })
    expect(await renderSubagentModelGuide(catalog.language)).toContain("context 256k tokens")
    unavailable = true
    const warning = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await renderSubagentModelGuide(catalog.language)).toContain("context 128k tokens")
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })
  test("lists each model by its exact reference with provider-declared metadata only", async () => {
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
    expect(await renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway/private","modelId":"specialist"} (default; metadata unavailable)',
        '- {"provider":"gateway","modelId":"private/specialist"} (context 400k tokens; reasoning; tools)',
      ].join("\n")
    )
  })

  test("gives each model its name and description on one line", async () => {
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

    expect(await renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway","modelId":"openai/gpt-5.5"} GPT (default; tools): A second opinion, useful to compare an analysis.',
      ].join("\n")
    )
  })
})
