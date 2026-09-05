import type { LanguageModel } from "../../src/models"

/** Admission tests register models but never invoke a provider. */
export function testLanguageModel(modelId = "test-model"): LanguageModel {
  return {
    providerId: "test",
    modelId,
    definition: {
      kind: "language",
      providerId: "test",
      modelId,
      capabilities: {},
      contextWindow: 32_000,
    },
    async stream() {
      throw new Error("Test model must not be invoked.")
    },
  }
}
