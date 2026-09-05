import type { LanguageModelV4 } from "@ai-sdk/provider"

/** Admission tests register models but never invoke a provider. */
export function testLanguageModel(modelId = "test-model"): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId,
    supportedUrls: {},
    async doGenerate() {
      throw new Error("Test model must not be invoked.")
    },
    async doStream() {
      throw new Error("Test model must not be invoked.")
    },
  }
}
