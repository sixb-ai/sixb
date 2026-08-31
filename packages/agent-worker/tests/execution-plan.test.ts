import { describe, expect, test } from "bun:test"
import {
  defineAgent,
  defineAgentTool,
  type LanguageModelCatalog,
  type LanguageModelEntry,
  type LanguageModelRef,
} from "@sixb/core"
import { resolveAgentExecutionPlan } from "../src/execution-plan"
import { WorkerTestModel } from "./worker-model-fixture"

describe("resolveAgentExecutionPlan", () => {
  test("maps executable configuration and resolves the worker step default", () => {
    const model = new WorkerTestModel({ modelId: "mock-model" })
    const lookup = defineAgentTool("lookup")
      .description("Look up a value.")
      .input({ query: "string" })
      .run(({ input }) => ({ result: input.query }))
    const configured = defineAgent("configured", {
      name: "Configured",
      model,
      reasoning: "high",
      instructions: "Resolve the request.",
      tools: [lookup],
      loop: { stopWhen: { maxSteps: 12 }, caching: "off" },
    })

    const configuredPlan = resolveAgentExecutionPlan({
      agent: configured,
      defaultMaxSteps: 100,
    })

    expect(configuredPlan).toEqual({
      model,
      reasoning: "high",
      instructions: "Resolve the request.",
      tools: [lookup],
      maxSteps: 12,
      caching: "off",
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
    const declaredModel = new WorkerTestModel({ modelId: "shared-model" })
    const catalogModel = new WorkerTestModel({ modelId: "shared-model" })
    const agent = defineAgent("configured", {
      name: "Configured",
      model: declaredModel,
      instructions: "Resolve the request.",
    })
    const entry: LanguageModelEntry = Object.freeze({
      provider: catalogModel.providerId,
      modelId: catalogModel.modelId,
      model: catalogModel,
    })
    const models: LanguageModelCatalog = Object.freeze({
      default: entry,
      list: () => [entry],
      getByRef: (ref: LanguageModelRef) =>
        ref.provider === entry.provider && ref.modelId === entry.modelId ? entry : null,
    })

    const plan = resolveAgentExecutionPlan({ agent, models, defaultMaxSteps: 100 })

    expect(plan.model).toBe(catalogModel)
    expect(plan.model).not.toBe(declaredModel)
  })

  test("fails closed when an agent model is missing from a configured catalog", () => {
    const model = new WorkerTestModel({ modelId: "missing-model" })
    const agent = defineAgent("missing", {
      name: "Missing",
      model,
      instructions: "Resolve the request.",
    })
    const otherModel = new WorkerTestModel({ modelId: "other-model" })
    const entry: LanguageModelEntry = {
      provider: otherModel.providerId,
      modelId: otherModel.modelId,
      model: otherModel,
    }
    const models: LanguageModelCatalog = {
      default: entry,
      list: () => [entry],
      getByRef: () => null,
    }

    expect(() => resolveAgentExecutionPlan({ agent, models, defaultMaxSteps: 100 })).toThrow(
      /missing from the runtime catalog/
    )
  })
})
