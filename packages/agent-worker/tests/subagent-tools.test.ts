import { describe, expect, test } from "bun:test"
import { createModelCatalog } from "@sixb/core/models"
import { renderSubagentModelGuide } from "../src/subagent-tools"
import { WorkerTestModel } from "./worker-model-fixture"

describe("subagent model guidance", () => {
  test("identifies the default and uses provider-declared metadata without inventing prices", () => {
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
    expect(renderSubagentModelGuide(catalog.language)).toBe(
      [
        "Available models (provider-declared metadata when available):",
        "- gateway/model (default; context 400k tokens; reasoning; tools)",
      ].join("\n")
    )
  })
  test("keeps unknown metadata explicit", () => {
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
    expect(renderSubagentModelGuide(catalog.language)).toContain(
      "- private/specialist (default; metadata unavailable)"
    )
  })
})
