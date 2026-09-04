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
import { MockLanguageModelV4 } from "ai/test"
import {
  resolveAgentExecutionPlan,
  resolveWorkflowAgentStepExecutionPlan,
} from "../src/execution-plan"

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

  test("uses the immutable model selection captured on a conversational run", () => {
    const defaultModel = new MockLanguageModelV4({ modelId: "default-model" })
    const selectedModel = new MockLanguageModelV4({ modelId: "selected-model" })
    const agent = defineAgent("configured", {
      name: "Configured",
      model: defaultModel,
      reasoning: "medium",
      instructions: "Resolve the request.",
    })
    const entries: readonly LanguageModelEntry[] = [defaultModel, selectedModel].map((model) => ({
      provider: model.provider,
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
        model: { provider: selectedModel.provider, modelId: selectedModel.modelId },
        reasoning: "high",
      },
      models,
      defaultMaxSteps: 25,
    })

    expect(plan.model).toBe(selectedModel)
    expect(plan.reasoning).toBe("high")
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

describe("resolveWorkflowAgentStepExecutionPlan", () => {
  test("uses the project default model and grants no project tools by default", () => {
    const model = new MockLanguageModelV4({ modelId: "default-model" })
    const entry: LanguageModelEntry = {
      provider: model.provider,
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
    const model = new MockLanguageModelV4({ modelId: "task-model" })
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
