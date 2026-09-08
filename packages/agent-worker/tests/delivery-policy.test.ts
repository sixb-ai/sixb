import { describe, expect, test } from "bun:test"
import { AgentDefinitionError } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { ModelProviderError, UnsupportedModelFeatureError } from "@sixb/core/models"
import { MAX_AGENT_DELIVERY_ATTEMPTS, shouldRetryAgentPreparation } from "../src/delivery-policy"

describe("agent preparation retries", () => {
  // Regression proof: classify only Sixb errors; native model/configuration failures retry.
  test.each([
    new AgentDefinitionError("Invalid output allowance"),
    new UnsupportedModelFeatureError("Unsupported reasoning"),
    new ModelProviderError("Unsupported model", "test", "model"),
    createSixbError("agent.execution_failed", "Revoked authority"),
  ])("does not retry a permanent preparation error", (error) => {
    expect(shouldRetryAgentPreparation(error, 1)).toBe(false)
  })

  test.each([
    new Error("Storage unavailable"),
    new ModelProviderError("Provider unavailable", "test", "model", { retryable: true }),
  ])("bounds retries for a recoverable dependency failure", (error) => {
    expect(shouldRetryAgentPreparation(error, 1)).toBe(true)
    expect(shouldRetryAgentPreparation(error, MAX_AGENT_DELIVERY_ATTEMPTS)).toBe(false)
  })
})
