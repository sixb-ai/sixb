import { describe, expect, test } from "bun:test"
import {
  type AgentStepDefinition,
  type AgentToolCatalog,
  type AgentToolDefinition,
  defineAgent,
  defineAgentStep,
  defineAgentTool,
  type LanguageModelCatalog,
  type LanguageModelEntry,
  type LanguageModelRef,
} from "@sixb/core"
import {
  resolveAgentExecutionPlan,
  resolveWorkflowAgentStepExecutionPlan,
} from "../src/execution-plan"
import { WorkerTestModel } from "./worker-model-fixture"

function workflowStep(config: Parameters<typeof defineAgentStep>[1]): AgentStepDefinition {
  return defineAgentStep("review", config)
    .input({ request: "string" })
    .output({ answer: "string" })
    .prompt(({ input }) => input.request)
}

function toolCatalog(tools: readonly AgentToolDefinition[]): AgentToolCatalog {
  return {
    list: () => tools,
    getByName: (name) => tools.find((tool) => tool.name === name) ?? null,
  }
}

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

  test("uses the immutable model selection captured on a conversational run", () => {
    const defaultModel = new WorkerTestModel({ modelId: "default-model" })
    const selectedModel = new WorkerTestModel({ modelId: "selected-model" })
    const agent = defineAgent("configured", {
      name: "Configured",
      model: defaultModel,
      reasoning: "medium",
      instructions: "Resolve the request.",
    })
    const entries: readonly LanguageModelEntry[] = [defaultModel, selectedModel].map((model) => ({
      provider: model.providerId,
      modelId: model.modelId,
      model,
    }))
    const models: LanguageModelCatalog = {
      default: entries[0]!,
      list: () => entries,
      getByRef: (ref) =>
        entries.find((entry) => entry.provider === ref.provider && entry.modelId === ref.modelId) ??
        null,
    }

    const plan = resolveAgentExecutionPlan({
      agent,
      spec: {
        model: { provider: selectedModel.providerId, modelId: selectedModel.modelId },
        reasoning: "high",
      },
      models,
      defaultMaxSteps: 25,
    })

    expect(plan.model).toBe(selectedModel)
    expect(plan.reasoning).toBe("high")
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

describe("resolveWorkflowAgentStepExecutionPlan", () => {
  test("uses the project default model and grants no project tools by default", () => {
    const model = new WorkerTestModel({ modelId: "default-model" })
    const entry: LanguageModelEntry = {
      provider: model.providerId,
      modelId: model.modelId,
      model,
    }
    const models: LanguageModelCatalog = {
      default: entry,
      list: () => [entry],
      getByRef: () => entry,
    }

    const plan = resolveWorkflowAgentStepExecutionPlan({
      workflowId: "triage",
      step: workflowStep({ instructions: "Review the request." }),
      models,
      tools: toolCatalog([]),
      defaultMaxSteps: 25,
    })

    expect(plan.model).toBe(model)
    expect(plan.instructions).toBe("Review the request.")
    expect(plan.tools).toEqual([])
    expect(plan.maxSteps).toBe(25)
  })

  test("resolves only the tools selected by the workflow step", () => {
    const model = new WorkerTestModel({ modelId: "task-model" })
    const selected = defineAgentTool("selected")
      .description("Selected tool.")
      .input({ value: "string" })
      .run(({ input }) => input)
    const unselected = defineAgentTool("unselected")
      .description("Unselected tool.")
      .input({ value: "string" })
      .run(({ input }) => input)

    const plan = resolveWorkflowAgentStepExecutionPlan({
      workflowId: "triage",
      step: workflowStep({
        model,
        reasoning: "high",
        instructions: "Review the request.",
        tools: [selected],
      }),
      tools: toolCatalog([selected, unselected]),
      defaultMaxSteps: 9,
    })

    expect(plan.model).toBe(model)
    expect(plan.reasoning).toBe("high")
    expect(plan.tools).toEqual([selected])
    expect(plan.maxSteps).toBe(9)
  })
})
