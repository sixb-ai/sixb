import { describe, expect, test } from "bun:test"
import type { LanguageModelCatalog, LanguageModelEntry } from "@sixb/core"
import { MockLanguageModelV4 } from "ai/test"
import * as modelsDev from "../src/models-dev/catalog"
import { renderSubagentModelGuide } from "../src/subagent-tools"

describe("subagent model guidance", () => {
  test("identifies the default and includes exact Models.dev metadata", () => {
    const catalog = languageModels([
      new MockLanguageModelV4({ provider: "gateway", modelId: "openai/gpt-5.4-mini" }),
      new MockLanguageModelV4({ provider: "private", modelId: "specialist" }),
    ])

    expect(renderSubagentModelGuide(catalog, modelsDev)).toBe(
      [
        "Available models (Models.dev base reference metadata when available):",
        "- gateway/openai/gpt-5.4-mini (default; base input $0.75 / output $4.5 per 1M tokens; context 400k tokens)",
        "- private/specialist (metadata unavailable)",
      ].join("\n")
    )
  })

  test("keeps an unknown default explicit", () => {
    const catalog = languageModels([
      new MockLanguageModelV4({ provider: "private", modelId: "specialist" }),
    ])

    expect(renderSubagentModelGuide(catalog, modelsDev)).toContain(
      "- private/specialist (default; metadata unavailable)"
    )
  })
})

function languageModels(models: readonly MockLanguageModelV4[]): LanguageModelCatalog {
  const entries: readonly LanguageModelEntry[] = models.map((model) => ({
    provider: model.provider,
    modelId: model.modelId,
    model,
  }))
  const [defaultModel] = entries
  if (!defaultModel) throw new Error("Expected at least one test model.")

  return {
    default: defaultModel,
    list: () => entries,
    getByRef: (ref) =>
      entries.find((model) => model.provider === ref.provider && model.modelId === ref.modelId) ??
      null,
  }
}
