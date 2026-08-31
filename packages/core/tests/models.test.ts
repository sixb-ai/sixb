import { describe, expect, test } from "bun:test"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import { createModelCatalog } from "../src/models"

/** The catalog only reads `provider` and `modelId`, so a conforming stub is enough. */
function testModel(provider: string, modelId: string): LanguageModelV4 {
  return { specificationVersion: "v4", provider, modelId } as LanguageModelV4
}

const gpt = testModel("gateway", "openai/gpt-5.4")
const sonnet = testModel("gateway", "anthropic/claude-sonnet-4.6")

describe("createModelCatalog", () => {
  test("derives an entry reference from provider and modelId", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(catalog.language.list().map((entry) => entry.ref)).toEqual(["gateway/openai/gpt-5.4"])
  })

  test("preserves the configured order", () => {
    const catalog = createModelCatalog({ language: [gpt, sonnet] })

    expect(catalog.language.list().map((entry) => entry.modelId)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4.6",
    ])
  })

  test("uses the first language model as the default", () => {
    const catalog = createModelCatalog({ language: [gpt, sonnet] })

    expect(catalog.language.default.ref).toBe("gateway/openai/gpt-5.4")
  })

  test("resolves an entry by reference and returns null for an unknown one", () => {
    const catalog = createModelCatalog({ language: [gpt] })

    expect(catalog.language.getById("gateway/openai/gpt-5.4")?.model).toBe(gpt)
    expect(catalog.language.getById("gateway/openai/gpt-9")).toBeNull()
  })

  test("rejects two models that derive the same reference", () => {
    // Proven by removal: drop the `byRef.has(ref)` guard in `createModelCatalog` and this fails —
    // the second entry replaces the first in the lookup while `list()` still reports both.
    expect(() =>
      createModelCatalog({ language: [gpt, testModel("gateway", "openai/gpt-5.4")] })
    ).toThrow(/Duplicate language model 'gateway\/openai\/gpt-5\.4'/)
  })

  test("keeps one vendor model configured through two bindings as two entries", () => {
    const catalog = createModelCatalog({
      language: [testModel("openai.chat", "gpt-5.4"), testModel("openai.responses", "gpt-5.4")],
    })

    expect(catalog.language.list().map((entry) => entry.ref)).toEqual([
      "openai.chat/gpt-5.4",
      "openai.responses/gpt-5.4",
    ])
  })

  test("rejects an empty language catalog", () => {
    // Proven by removal: drop the `defaultEntry === undefined` guard and this fails, because
    // `default` then reads as undefined instead of the catalog refusing to exist.
    expect(() => createModelCatalog({ language: [] })).toThrow(
      /'models.language' needs at least one model/
    )
  })
})
