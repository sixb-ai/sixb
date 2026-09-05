import { describe, expect, test } from "bun:test"
import type { AgentContextConfig, AgentDefinition } from "@sixb/core"
import {
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  resolveAgentContextBudget,
} from "../src/context-budget"
import { resolveModelsDevContextLimits } from "../src/models-dev/catalog"
import { WorkerTestModel } from "./worker-model-fixture"

function agent(
  provider: string,
  modelId: string,
  context?: AgentContextConfig
): Pick<AgentDefinition, "id" | "model" | "loop"> {
  return {
    id: "assistant",
    model: new WorkerTestModel({ providerId: provider, modelId }),
    ...(context === undefined ? {} : { loop: { context } }),
  }
}

function resolveBudget(definition: Pick<AgentDefinition, "id" | "model" | "loop">) {
  return resolveAgentContextBudget(definition, resolveModelsDevContextLimits(definition.model))
}

describe("agent context budget resolution", () => {
  test("prefers owned model metadata over the fallback catalog", () => {
    // Regression proof: ignore definition.contextWindow in resolveAgentContextBudget.
    const definition = agent("vercel-ai-gateway", "openai/gpt-5.4")
    const configured = {
      ...definition,
      model: new WorkerTestModel({
        definition: { ...definition.model.definition, contextWindow: 32_000 },
      }),
    }
    expect(resolveBudget(configured)).toMatchObject({ windowTokens: 32_000, source: "model" })
    expect(
      resolveBudget({ ...configured, loop: { context: { windowTokens: 16_000 } } })
    ).toMatchObject({ windowTokens: 16_000, source: "config" })
  })

  test("maps the owned Gateway provider to the context catalog", () => {
    // Regression proof: remove the vercel-ai-gateway provider binding.
    expect(resolveBudget(agent("vercel-ai-gateway", "openai/gpt-5.4"))).toMatchObject({
      windowTokens: 1_050_000,
      source: "models.dev",
    })
  })
  test("uses the exact Models.dev context and input limits", () => {
    expect(resolveBudget(agent("openai", "gpt-5.4"))).toEqual({
      windowTokens: 1_050_000,
      inputBudgetTokens: 922_000,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "models.dev",
    })
  })

  test("uses exact provider identities without fuzzy model matching", () => {
    expect(resolveBudget(agent("vercel-ai-gateway", "openai/gpt-5.4"))).toMatchObject({
      windowTokens: 1_050_000,
      source: "models.dev",
    })
    expect(resolveBudget(agent("openai.responses.extra", "gpt-5.4"))).toEqual({
      windowTokens: DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
      inputBudgetTokens: 111_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "fallback",
    })
  })

  test("treats an explicit window as authoritative", () => {
    expect(resolveBudget(agent("openai", "gpt-5.4", { windowTokens: 1_500_000 }))).toEqual({
      windowTokens: 1_500_000,
      inputBudgetTokens: 1_483_616,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      source: "config",
    })
  })

  test("applies advanced overrides to a catalog-derived window", () => {
    expect(
      resolveBudget(
        agent("openai", "gpt-5.4", {
          reserveTokens: 200_000,
          keepRecentTokens: 10_000,
        })
      )
    ).toEqual({
      windowTokens: 1_050_000,
      inputBudgetTokens: 850_000,
      reserveTokens: 200_000,
      keepRecentTokens: 10_000,
      source: "models.dev",
    })
  })

  test("rejects overrides that cannot produce a safe input budget", () => {
    expect(() =>
      resolveBudget(
        agent("unknown", "unknown", {
          windowTokens: 10_000,
          reserveTokens: 10_000,
        })
      )
    ).toThrow("reserveTokens must be less than the resolved context window")

    expect(() =>
      resolveBudget(
        agent("unknown", "unknown", {
          windowTokens: 10_000,
          keepRecentTokens: 9_000,
        })
      )
    ).toThrow("keepRecentTokens must be less than the resolved input budget")
  })
})
