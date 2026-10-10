import { describe, expect, test } from "bun:test"
import {
  type AgentSkillCatalog,
  type AgentSkillDefinition,
  type AgentStepDefinition,
  type AgentToolCatalog,
  type AgentToolDefinition,
  defineAgentStep,
  defineAgentTool,
  type LanguageModelCatalog,
  type LanguageModelEntry,
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

function skill(name: string): AgentSkillDefinition {
  return { name, description: `Use for ${name}.`, files: [] }
}

function skillCatalog(skills: readonly AgentSkillDefinition[]): AgentSkillCatalog {
  return {
    list: () => skills,
    getByName: (name) => skills.find((candidate) => candidate.name === name) ?? null,
  }
}

describe("resolveAgentExecutionPlan", () => {
  const defaultModel = new WorkerTestModel({ modelId: "default" })
  const selectedModel = new WorkerTestModel({ modelId: "selected" })
  const entries = [defaultModel, selectedModel].map((model) => ({
    model,
    provider: model.providerId,
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
  const skills = skillCatalog([skill("invoice-review")])

  test("uses project capabilities without redundant conversational instructions", () => {
    const plan = resolveAgentExecutionPlan({ models, tools, skills, defaultMaxSteps: 25 })
    expect(plan).toEqual({
      model: defaultModel,
      tools: [lookup],
      skills: [skill("invoice-review")],
      maxSteps: 25,
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect("agentId" in plan).toBe(false)
  })

  test("carries the project instructions from SIXB.md", () => {
    const plan = resolveAgentExecutionPlan({
      models,
      tools,
      skills,
      projectInstructions: "Answer in French.",
      defaultMaxSteps: 25,
    })
    expect(plan.instructions).toBe("Answer in French.")
  })

  test("uses the immutable selection captured at admission", () => {
    const spec = {
      model: { provider: selectedModel.providerId, modelId: selectedModel.modelId },
      reasoning: "high" as const,
    }
    const plan = resolveAgentExecutionPlan({ spec, models, tools, skills, defaultMaxSteps: 7 })
    expect(plan.model).toBe(selectedModel)
    expect(plan.reasoning).toBe("high")
    expect(plan.maxSteps).toBe(7)
  })

  test("fails closed when a selected model disappears or no models are configured", () => {
    expect(() =>
      resolveAgentExecutionPlan({
        models,
        tools,
        skills,
        defaultMaxSteps: 25,
        spec: { model: { provider: selectedModel.providerId, modelId: "removed" } },
      })
    ).toThrow(/not available in models.language/)
    expect(() => resolveAgentExecutionPlan({ tools, skills, defaultMaxSteps: 25 })).toThrow(
      /not available in models.language/
    )
  })
})

describe("resolveWorkflowAgentStepExecutionPlan", () => {
  test("uses the project default model and grants no project tools or skills by default", () => {
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
      skills: skillCatalog([skill("invoice-review")]),
      defaultMaxSteps: 25,
    })

    expect(plan.model).toBe(model)
    expect(plan.instructions).toBe("Review the request.")
    expect(plan.tools).toEqual([])
    expect(plan.skills).toEqual([])
    expect(plan.maxSteps).toBe(25)
  })

  test("resolves only the tools and skills selected by the workflow step", () => {
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
        skills: ["invoice-review"],
      }),
      tools: toolCatalog([selected, unselected]),
      skills: skillCatalog([skill("contract-review"), skill("invoice-review")]),
      defaultMaxSteps: 9,
    })

    expect(plan.model).toBe(model)
    expect(plan.reasoning).toBe("high")
    expect(plan.tools).toEqual([selected])
    expect(plan.skills).toEqual([skill("invoice-review")])
    expect(plan.maxSteps).toBe(9)
  })

  test("fails clearly when a selected skill is no longer registered", () => {
    expect(() =>
      resolveWorkflowAgentStepExecutionPlan({
        workflowId: "triage",
        step: workflowStep({
          model: new WorkerTestModel({ modelId: "task-model" }),
          instructions: "Review the request.",
          skills: ["invoice-review"],
        }),
        tools: toolCatalog([]),
        skills: skillCatalog([]),
        defaultMaxSteps: 9,
      })
    ).toThrow("cannot resolve Agent Skill 'invoice-review'")
  })
})
