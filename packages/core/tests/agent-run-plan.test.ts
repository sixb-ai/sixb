import { describe, expect, test } from "bun:test"
import {
  type AgentRunPlanDefinitions,
  type AgentRunView,
  readAgentRunPlan,
  UNATTENDED_AGENT_MAX_STEPS,
} from "../src/agents"
import { defineAgentTool } from "../src/agents/builders"
import type { AgentSkillDefinition } from "../src/agents/skills"
import type { AgentToolDefinition } from "../src/agents/types"
import type { LanguageModel } from "../src/models"
import { createModelCatalog } from "../src/models"
import { createOntologyDocsCatalog } from "../src/ontology/docs"
import type { AgentRunRecord } from "../src/storage/agents"

function model(modelId: string, defaultReasoning?: "low" | "high"): LanguageModel {
  return {
    providerId: "test",
    modelId,
    ...(defaultReasoning ? { defaultReasoning } : {}),
    definition: {
      kind: "language",
      providerId: "test",
      modelId,
      capabilities: {},
      contextWindow: 32_000,
    },
    async stream() {
      throw new Error("A plan never calls its model.")
    },
  }
}

const invoiceReview: AgentSkillDefinition = {
  name: "invoice-review",
  description: "Use for invoices.",
  files: [],
}

const lookup = defineAgentTool("lookup")
  .description("Look up.")
  .input({ id: "string" })
  .run(({ input }) => input)
const exporter = defineAgentTool("export")
  .description("Export.")
  .input({})
  .run(() => ({}))
const tools = new Map<string, AgentToolDefinition>([
  ["lookup", lookup],
  ["export", exporter],
])

function definitions(
  input: {
    readonly instructions?: string
    readonly maxSteps?: number
    readonly subagentMaxSteps?: number
  } = {}
): AgentRunPlanDefinitions {
  const models = createModelCatalog({
    language: [model("default", "low"), model("selected")],
  })
  return {
    agent: {
      skills: { list: () => [invoiceReview], getByName: () => invoiceReview },
      ontologyDocs: createOntologyDocsCatalog({ objectTypes: [] }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
      ...(input.subagentMaxSteps === undefined ? {} : { subagentMaxSteps: input.subagentMaxSteps }),
    },
    models,
    tools: { list: () => [lookup, exporter], getByName: (name: string) => tools.get(name) ?? null },
    ontology: { getValueTypesById: () => new Map() },
  } as unknown as AgentRunPlanDefinitions
}

/** A requester who sees no object types: the plan's docs hold the project's other docs alone. */
const VIEW = {
  sixb: {
    objects: { listTypes: () => [], getValueTypesById: () => new Map() },
    actions: { listForType: () => [] },
  },
} as unknown as AgentRunView

/** A conversation's turn, with the spec its admission froze, or none for an older one. */
function turn(spec?: object): AgentRunRecord {
  return { id: "run_1", kind: "conversation", ...(spec ? { spec } : {}) } as AgentRunRecord
}

describe("a turn's plan", () => {
  test("offers every project tool and skill, with instructions only from SIXB.md", () => {
    const { delegation, ...plan } = readAgentRunPlan(definitions(), turn(), VIEW)
    expect(plan).toEqual({
      model: { provider: "test", modelId: "default" },
      reasoning: "low",
      skills: [invoiceReview],
      tools: [
        { name: "lookup", description: "Look up.", inputSchema: expect.any(Object) },
        { name: "export", description: "Export.", inputSchema: expect.any(Object) },
      ],
      sandboxModels: [
        { kind: "language", provider: "test", modelId: "default" },
        { kind: "language", provider: "test", modelId: "selected" },
      ],
      ontologyDocs: { files: [], index: [] },
    })
    // What a child may run on: the project's models, each as its binding configures it.
    expect(delegation).toMatchObject({
      defaultModel: { provider: "test", modelId: "default" },
      tiers: [],
      models: [
        { provider: "test", modelId: "default", defaultReasoning: "low" },
        { provider: "test", modelId: "selected", definition: { modelId: "selected" } },
      ],
    })
    expect(
      readAgentRunPlan(definitions({ instructions: "Answer in French." }), turn(), VIEW)
        .instructions
    ).toBe("Answer in French.")
  })

  // Proven by removal: read the model's `defaultReasoning` whenever the spec has none.
  test("keeps the model and reasoning frozen at admission", () => {
    const selected = { model: { provider: "test", modelId: "selected" }, reasoning: "high" }
    expect(readAgentRunPlan(definitions(), turn(selected), VIEW)).toMatchObject({
      model: { provider: "test", modelId: "selected" },
      reasoning: "high",
    })
    const noReasoning = { model: { provider: "test", modelId: "default" } }
    expect(readAgentRunPlan(definitions(), turn(noReasoning), VIEW)).not.toHaveProperty("reasoning")
  })

  // Proven by removal: drop `maxSteps` from the turn's plan, or default it like a child's.
  test("runs until its model answers unless the project sets maxSteps", () => {
    expect(readAgentRunPlan(definitions(), turn(), VIEW)).not.toHaveProperty("maxSteps")
    expect(readAgentRunPlan(definitions({ maxSteps: 40 }), turn(), VIEW).maxSteps).toBe(40)

    // What it may hand a child: the project's limit, else the default.
    expect(readAgentRunPlan(definitions(), turn(), VIEW).delegation?.maxSteps).toBe(
      UNATTENDED_AGENT_MAX_STEPS
    )
    expect(
      readAgentRunPlan(definitions({ subagentMaxSteps: 80 }), turn(), VIEW).delegation?.maxSteps
    ).toBe(80)
  })

  test("fails closed when its model is gone", () => {
    expect(() =>
      readAgentRunPlan(
        definitions(),
        turn({ model: { provider: "test", modelId: "removed" } }),
        VIEW
      )
    ).toThrow(/not available in models.language/)
  })
})

describe("a child's plan", () => {
  test("keeps the model, tools and settings its parent chose", () => {
    const child = {
      id: "run_1-child",
      kind: "subagent",
      parentRunId: "run_1",
      spec: {
        model: { provider: "test", modelId: "selected" },
        task: "Look west.",
        toolNames: ["lookup"],
        timeZone: "Europe/Paris",
      },
    } as unknown as AgentRunRecord

    const plan = readAgentRunPlan(definitions(), child, VIEW)
    // A child spawns no children of its own.
    expect(plan).not.toHaveProperty("delegation")
    expect(plan).toMatchObject({
      model: { provider: "test", modelId: "selected" },
      tools: [{ name: "lookup" }],
      timeZone: "Europe/Paris",
    })
  })

  // Proven by removal: drop the `Math.min` and a spawn's maxSteps outlives a lower project limit;
  // drop the default and an unconfigured child runs without one.
  test("stops at what its spawn asked for, within the project's limit", () => {
    const child = (maxSteps?: number) =>
      ({
        id: "run_1-child",
        kind: "subagent",
        parentRunId: "run_1",
        spec: {
          model: { provider: "test", modelId: "selected" },
          task: "Look west.",
          toolNames: [],
          ...(maxSteps === undefined ? {} : { maxSteps }),
        },
      }) as unknown as AgentRunRecord

    expect(readAgentRunPlan(definitions(), child(), VIEW).maxSteps).toBe(UNATTENDED_AGENT_MAX_STEPS)
    expect(readAgentRunPlan(definitions({ subagentMaxSteps: 80 }), child(), VIEW).maxSteps).toBe(80)
    expect(readAgentRunPlan(definitions(), child(20), VIEW).maxSteps).toBe(20)
    expect(readAgentRunPlan(definitions({ subagentMaxSteps: 10 }), child(20), VIEW).maxSteps).toBe(
      10
    )
  })
})
