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
  test("identifies the default and uses provider-declared metadata without inventing prices", async () => {
    const catalog = createModelCatalog({
      language: [
        new WorkerTestModel({
          definition: {
            kind: "language",
            providerId: "gateway",
            modelId: "model",
            contextWindow: 400_000,
            capabilities: { reasoning: { efforts: ["high"] }, localTools: true },
          },
        }),
      ],
    })
    expect(await renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        '- {"provider":"gateway","modelId":"model"} (default; context 400k tokens; reasoning; tools)',
      ].join("\n")
    )
  })
  test("keeps unknown metadata explicit", async () => {
    const catalog = createModelCatalog({
      language: [
        new WorkerTestModel({
          definition: {
            kind: "language",
            providerId: "private",
            modelId: "specialist",
            capabilities: {},
          },
        }),
      ],
    })
    expect(await renderSubagentModelGuide(catalog.language)).toContain(
      '- {"provider":"private","modelId":"specialist"} (default; metadata unavailable)'
    )
  })

  test("distinguishes references with identical slash-joined labels", async () => {
    const catalog = createModelCatalog({
      language: [
        new WorkerTestModel({ providerId: "gateway", modelId: "private/specialist" }),
        new WorkerTestModel({ providerId: "gateway/private", modelId: "specialist" }),
      ],
    }).language

    const guide = await renderSubagentModelGuide(catalog)
    expect(guide).toContain('{"provider":"gateway","modelId":"private/specialist"}')
    expect(guide).toContain('{"provider":"gateway/private","modelId":"specialist"}')
  })
})
