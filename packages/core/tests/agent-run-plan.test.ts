import { describe, expect, test } from "bun:test"
import { type AgentRunPlanDefinitions, type AgentRunView, readAgentRunPlan } from "../src/agents"
import type { AgentSkillDefinition } from "../src/agents/skills"
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

function definitions(input: { readonly instructions?: string } = {}): AgentRunPlanDefinitions {
  const models = createModelCatalog({
    language: [model("default", "low"), model("selected")],
  })
  return {
    agent: {
      skills: { list: () => [invoiceReview], getByName: () => invoiceReview },
      ontologyDocs: createOntologyDocsCatalog({ objectTypes: [] }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    },
    models,
    tools: {
      list: () => [{ name: "lookup" }, { name: "export" }],
      getByName: () => null,
    },
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
    expect(readAgentRunPlan(definitions(), turn(), VIEW)).toEqual({
      model: { provider: "test", modelId: "default" },
      reasoning: "low",
      skills: [invoiceReview],
      toolNames: ["lookup", "export"],
      sandboxModels: [
        { kind: "language", provider: "test", modelId: "default" },
        { kind: "language", provider: "test", modelId: "selected" },
      ],
      ontologyDocs: { files: [], index: [] },
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

    expect(readAgentRunPlan(definitions(), child, VIEW)).toMatchObject({
      model: { provider: "test", modelId: "selected" },
      toolNames: ["lookup"],
      timeZone: "Europe/Paris",
    })
  })
})
