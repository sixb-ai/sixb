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
  type SixbDefinitions,
} from "@sixb/core"
import { type AgentRunPlan, agentToolSpec } from "@sixb/core/internal/agents"
import { createModelCatalog } from "@sixb/core/models"
import { resolveRunPlan } from "../../agent/src/execution-plan"
import { BUILT_IN_SKILLS } from "../../agent/src/skills/built-in"
import { WorkerTestModel } from "../../agent/tests/worker-model-fixture"
import { resolveWorkflowAgentStepPlan } from "../src/run-plan"

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

/** Definitions that hold these catalogs, and nothing a plan does not read. */
function definitionsOf(input: {
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills?: AgentSkillCatalog
}) {
  return {
    agent: { skills: input.skills ?? skillCatalog([]) },
    ontology: { getValueTypesById: () => new Map() },
    ...(input.models === undefined ? {} : { models: { language: input.models } }),
    tools: input.tools,
  } as unknown as Pick<SixbDefinitions, "agent" | "models" | "ontology" | "tools">
}

/** A workflow step's plan, from definitions holding these catalogs. */
function stepPlan(input: {
  readonly workflowId: string
  readonly step: AgentStepDefinition
  readonly models?: LanguageModelCatalog
  readonly tools: AgentToolCatalog
  readonly skills: AgentSkillCatalog
}) {
  const { workflowId, step, ...catalogs } = input
  return resolveWorkflowAgentStepPlan(definitionsOf(catalogs), { workflowId, step })
}

describe("resolveRunPlan", () => {
  const model = new WorkerTestModel({ modelId: "default" })
  const lookup = defineAgentTool("lookup")
    .description("Look up a value.")
    .input({ query: "string" })
    .run(({ input }) => input)
  const plan: AgentRunPlan = {
    model: { provider: model.providerId, modelId: model.modelId },
    reasoning: "high",
    instructions: "Answer in French.",
    skills: [skill("invoice-review")],
    tools: [agentToolSpec(lookup, new Map())],
    sandboxModels: [],
    ontologyDocs: { files: [], index: [] },
  }

  test("takes the session's model and the plan's tool specs, and adds the harness's skills", () => {
    const resolved = resolveRunPlan(plan, { model })

    expect(resolved).toEqual({
      model,
      ontologyDocs: { files: [], index: [] },
      reasoning: "high",
      instructions: "Answer in French.",
      tools: [agentToolSpec(lookup, new Map())],
      skills: [skill("invoice-review"), ...BUILT_IN_SKILLS],
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })
})

describe("resolveWorkflowAgentStepPlan", () => {
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
      tiers: [],
      getByTier: () => entry,
    }

    const plan = stepPlan({
      workflowId: "triage",
      step: workflowStep({ instructions: "Review the request." }),
      models,
      tools: toolCatalog([]),
      skills: skillCatalog([skill("invoice-review")]),
    })

    expect(plan.model).toBe(model)
    expect(plan.instructions).toBe("Review the request.")
    expect(plan.tools).toEqual([])
    expect(plan.skills).toEqual([])
  })

  test("applies the project default model's default reasoning unless the step sets one", () => {
    // Proven by removal: drop `?? selected.defaultReasoning` from the workflow step plan.
    const model = new WorkerTestModel({ modelId: "default-model", defaultReasoning: "medium" })
    const entry: LanguageModelEntry = { provider: model.providerId, modelId: model.modelId, model }
    const models: LanguageModelCatalog = {
      default: entry,
      list: () => [entry],
      getByRef: () => entry,
      tiers: [],
      getByTier: () => entry,
    }
    const plan = (config: Parameters<typeof defineAgentStep>[1]) =>
      stepPlan({
        workflowId: "triage",
        step: workflowStep(config),
        models,
        tools: toolCatalog([]),
        skills: skillCatalog([]),
      })

    expect(plan({ instructions: "Review." }).reasoning).toBe("medium")
    expect(plan({ instructions: "Review.", reasoning: "high" }).reasoning).toBe("high")
  })

  test("runs the step's own model as given, whether or not the catalog lists it", () => {
    // Proven by removal: resolve an explicit step model through `models.getByRef` again.
    const listed = new WorkerTestModel({ modelId: "default-model", defaultReasoning: "medium" })
    const entry: LanguageModelEntry = {
      provider: listed.providerId,
      modelId: listed.modelId,
      model: listed,
    }
    const models: LanguageModelCatalog = {
      default: entry,
      list: () => [entry],
      getByRef: (ref) =>
        ref.provider === entry.provider && ref.modelId === entry.modelId ? entry : null,
      tiers: [],
      getByTier: () => entry,
    }
    const plan = (model: WorkerTestModel) =>
      stepPlan({
        workflowId: "triage",
        step: workflowStep({ instructions: "Review.", model }),
        models,
        tools: toolCatalog([]),
        skills: skillCatalog([]),
      })

    // Same identity as the catalog entry, other options: the step's binding and its default run.
    const sameId = new WorkerTestModel({ modelId: "default-model", defaultReasoning: "low" })
    const own = plan(sameId)
    expect(own.model).toBe(sameId)
    expect(own.reasoning).toBe("low")

    const unlisted = new WorkerTestModel({ modelId: "second-opinion" })
    const outside = plan(unlisted)
    expect(outside.model).toBe(unlisted)
    expect(outside).not.toHaveProperty("reasoning")
  })

  test("runs a tier's model from the catalog, and standard's for a tier left out", () => {
    // Proven by removal: select `step.model ?? models.default.model` again; the tier name is
    // passed on as the model.
    const light = new WorkerTestModel({ modelId: "light-model", defaultReasoning: "low" })
    const standard = new WorkerTestModel({ modelId: "standard-model" })
    const { language } = createModelCatalog({ language: { light, standard } })
    const plan = (model: "light" | "heavy") =>
      stepPlan({
        workflowId: "triage",
        step: workflowStep({ instructions: "Review.", model }),
        models: language,
        tools: toolCatalog([]),
        skills: skillCatalog([]),
      })

    expect(plan("light")).toMatchObject({ model: light, reasoning: "low" })
    expect(plan("heavy").model).toBe(standard)

    // Proven by removal: name the project default whatever the step asked for.
    expect(() =>
      stepPlan({
        workflowId: "triage",
        step: workflowStep({ instructions: "Review.", model: "light" }),
        tools: toolCatalog([]),
        skills: skillCatalog([]),
      })
    ).toThrow("agent step 'review' cannot resolve the model of tier 'light'.")
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

    const plan = stepPlan({
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
    })

    expect(plan.model).toBe(model)
    expect(plan.reasoning).toBe("high")
    expect(plan.tools).toEqual([agentToolSpec(selected, new Map())])
    expect(plan.skills).toEqual([skill("invoice-review")])
  })

  test("fails clearly when a selected skill is no longer registered", () => {
    expect(() =>
      stepPlan({
        workflowId: "triage",
        step: workflowStep({
          model: new WorkerTestModel({ modelId: "task-model" }),
          instructions: "Review the request.",
          skills: ["invoice-review"],
        }),
        tools: toolCatalog([]),
        skills: skillCatalog([]),
      })
    ).toThrow("cannot resolve Agent Skill 'invoice-review'")
  })
})
