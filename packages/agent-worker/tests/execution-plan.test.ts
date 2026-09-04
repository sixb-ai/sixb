import { describe, expect, test } from "bun:test"
import {
  defineAgent,
  defineAgentTool,
  type LanguageModelCatalog,
  type LanguageModelEntry,
  type LanguageModelRef,
} from "@sixb/core"
import { MockLanguageModelV4 } from "ai/test"
import { resolveAgentExecutionPlan } from "../src/execution-plan"

describe("resolveAgentExecutionPlan", () => {
  test("maps executable configuration and resolves the worker step default", () => {
    const model = new MockLanguageModelV4({ modelId: "mock-model" })
    const lookup = defineAgentTool("lookup")
      .description("Look up a value.")
      .input({ query: "string" })
      .run(({ input }) => ({ result: input.query }))
    const providerOptions = { openai: { reasoningSummary: "detailed" } }
    const configured = defineAgent("configured", {
      name: "Configured",
      model,
      reasoning: "high",
      providerOptions,
      instructions: "Resolve the request.",
      tools: [lookup],
      loop: { stopWhen: { maxSteps: 12 } },
    })

    const configuredPlan = resolveAgentExecutionPlan({
      agent: configured,
      defaultMaxSteps: 25,
    })

    expect(configuredPlan).toEqual({
      model,
      reasoning: "high",
      providerOptions,
      instructions: "Resolve the request.",
      tools: [lookup],
      maxSteps: 12,
    })
    expect(Object.isFrozen(configuredPlan)).toBe(true)
    expect("agentId" in configuredPlan).toBe(false)
    expect("groupIds" in configuredPlan).toBe(false)
    expect("name" in configuredPlan).toBe(false)

    const defaulted = defineAgent("defaulted", {
      name: "Defaulted",
      model,
      instructions: "Use the worker default.",
    })

    expect(resolveAgentExecutionPlan({ agent: defaulted, defaultMaxSteps: 7 }).maxSteps).toBe(7)
  })

  test("uses the project catalog as the authoritative model binding", () => {
    const declaredModel = new MockLanguageModelV4({ modelId: "shared-model" })
    const catalogModel = new MockLanguageModelV4({ modelId: "shared-model" })
    const agent = defineAgent("configured", {
      name: "Configured",
      model: declaredModel,
      instructions: "Resolve the request.",
    })
    const entry: LanguageModelEntry = Object.freeze({
      provider: catalogModel.provider,
      modelId: catalogModel.modelId,
      model: catalogModel,
    })
    const models: LanguageModelCatalog = Object.freeze({
      default: entry,
      list: () => [entry],
      getByRef: (ref: LanguageModelRef) =>
        ref.provider === entry.provider && ref.modelId === entry.modelId ? entry : null,
    })

    const plan = resolveAgentExecutionPlan({ agent, models, defaultMaxSteps: 25 })

    expect(plan.model).toBe(catalogModel)
    expect(plan.model).not.toBe(declaredModel)
  })

  test("fails closed when an agent model is missing from a configured catalog", () => {
    const model = new MockLanguageModelV4({ modelId: "missing-model" })
    const agent = defineAgent("missing", {
      name: "Missing",
      model,
      instructions: "Resolve the request.",
    })
    const otherModel = new MockLanguageModelV4({ modelId: "other-model" })
    const entry: LanguageModelEntry = {
      provider: otherModel.provider,
      modelId: otherModel.modelId,
      model: otherModel,
    }
    const models: LanguageModelCatalog = {
      default: entry,
      list: () => [entry],
      getByRef: () => null,
    }

    expect(() => resolveAgentExecutionPlan({ agent, models, defaultMaxSteps: 25 })).toThrow(
      /missing from the runtime catalog/
    )
  })
})
