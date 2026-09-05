import { describe, expect, test } from "bun:test"
import {
  type AgentStepDefinition,
  type AgentToolCatalog,
  type AgentToolDefinition,
  defineAgentStep,
  defineAgentTool,
  type LanguageModelCatalog,
  type LanguageModelEntry,
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
  const defaultModel = new MockLanguageModelV4({ modelId: "default" })
  const selectedModel = new MockLanguageModelV4({ modelId: "selected" })
  const entries = [defaultModel, selectedModel].map((model) => ({
    model,
    provider: model.provider,
    modelId: model.modelId,
  }))
  const models: LanguageModelCatalog = {
    default: entries[0]!,
    list: () => entries,
    getByRef: (ref) =>
      entries.find((entry) => entry.provider === ref.provider && entry.modelId === ref.modelId) ??
      null,
  }
  const lookup = defineAgentTool("lookup")
    .description("Look up a value.")
    .input({ query: "string" })
    .run(({ input }) => input)
  const tools = toolCatalog([lookup])

  test("uses project capabilities without redundant conversational instructions", () => {
    const plan = resolveAgentExecutionPlan({ models, tools, defaultMaxSteps: 25 })
    expect(plan).toEqual({
      model: defaultModel,
      tools: [lookup],
      maxSteps: 25,
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect("agentId" in plan).toBe(false)
  })

  test("uses the immutable selection captured at admission", () => {
    const spec = {
      model: { provider: selectedModel.provider, modelId: selectedModel.modelId },
      reasoning: "high" as const,
    }
    const plan = resolveAgentExecutionPlan({ spec, models, tools, defaultMaxSteps: 7 })
    expect(plan.model).toBe(selectedModel)
    expect(plan.reasoning).toBe("high")
    expect(plan.maxSteps).toBe(7)
  })

  test("fails closed when a selected model disappears or no models are configured", () => {
    expect(() =>
      resolveAgentExecutionPlan({
        models,
        tools,
        defaultMaxSteps: 25,
        spec: { model: { provider: selectedModel.provider, modelId: "removed" } },
      })
    ).toThrow(/not available in models.language/)
    expect(() => resolveAgentExecutionPlan({ tools, defaultMaxSteps: 25 })).toThrow(
      /not available in models.language/
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
