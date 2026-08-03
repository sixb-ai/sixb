import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import {
  AgentDefinitionError,
  createSixb,
  defineAgent,
  defineAgentTool,
  defineGroup,
  defineObjectType,
  isAgentDefinition,
  prop,
  RuntimeError,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

// These tests don't execute runs, so a stub conforming to the model type is enough.
const model = {} as LanguageModelV4
const agentRuntime = defineGroup("agent-runtime", { label: "Agent runtime" })

const Room = defineObjectType({
  id: "Room",
  name: "Room",
  properties: [prop("id", "string", { required: true, primary: true })],
})

afterEach(async () => {
  for (const root of tempRoots) {
    await rm(root, { recursive: true, force: true })
  }
  tempRoots.clear()
})

async function createTempProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sixb-core-agents-"))
  tempRoots.add(projectRoot)
  return projectRoot
}

async function writeProjectFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<void> {
  const absolutePath = join(projectRoot, relativePath)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, content, "utf-8")
}

// Fixture modules run through Bun (transpiled, not type-checked), so an inline
// stub model is fine — the runtime only requires it to be present.
function agentModule(id: string, name = "Agent"): string {
  return `import { defineAgent } from "${coreModuleUrl}"

export const ${id} = defineAgent("${id}", {
  name: "${name}",
  model: { specificationVersion: "v4", provider: "test", modelId: "test" },
  instructions: "You assist the user.",
})
`
}

function agentWithToolModule(id: string): string {
  return `import { defineAgent, defineAgentTool } from "${coreModuleUrl}"

export const searchKnowledge = defineAgentTool("search_knowledge")
  .description("Search project knowledge.")
  .input({ query: "string" })
  .run(({ input }) => ({ query: input.query, results: [] }))

export const ${id} = defineAgent("${id}", {
  name: "Agent with tools",
  model: { specificationVersion: "v4", provider: "test", modelId: "test" },
  instructions: "Use selected tools when needed.",
  tools: [searchKnowledge],
})
`
}

function validateToolInput(input: unknown): void {
  const builder = defineAgentTool("search").description("Search.") as unknown as {
    input(input: unknown): void
  }
  builder.input(input)
}

describe("defineAgentTool", () => {
  test("builds an inert tool definition and validates handler results", async () => {
    const searchKnowledge = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input({ query: "string", limit: "integer" })
      .run(({ input }) => ({ results: [input.query], limit: input.limit }))

    expect(searchKnowledge.kind).toBe("agentTool")
    expect(searchKnowledge.name).toBe("search_knowledge")
    expect(searchKnowledge.description).toBe("Search project knowledge.")
    expect(searchKnowledge.input).toEqual({ query: "string", limit: "integer" })
    await expect(
      searchKnowledge.handler({ input: { query: "sixb", limit: 3 } } as never)
    ).resolves.toEqual({ results: ["sixb"], limit: 3 })

    const invalidResult = defineAgentTool("invalid_result")
      .description("Return an invalid result.")
      .input({})
      .run((() => ({ value: undefined })) as never)

    await expect(invalidResult.handler({ input: {} } as never)).rejects.toThrow(
      "Agent tool 'invalid_result' result must be a JSON value"
    )
  })

  test("rejects invalid and reserved names", () => {
    const validateName = (name: string): void => {
      defineAgentTool(name)
    }
    for (const name of ["", "1search", "search knowledge", "a".repeat(65)]) {
      expect(() => validateName(name)).toThrow(AgentDefinitionError)
    }
    expect(() => validateName("bash")).toThrow("reserved by the framework")
  })

  test("rejects empty descriptions, invalid schemas, and missing handlers", () => {
    const validateHandler = (handler: unknown): void => {
      const builder = defineAgentTool("search").description("Search.").input({}) as unknown as {
        run(handler: unknown): void
      }
      builder.run(handler)
    }

    expect(() => defineAgentTool("search").description(" ")).toThrow(AgentDefinitionError)
    expect(() => validateToolInput({ query: "unknown" })).toThrow(
      "input.query must be a valid Sixb schema"
    )
    expect(() =>
      validateToolInput({ mode: { type: "enum", valueType: "string", values: [] } })
    ).toThrow("input.mode must be a valid Sixb schema")
    expect(() => validateHandler(undefined)).toThrow("handler must be a function")
  })

  test("rejects malformed nested input schemas", () => {
    const recursive: Record<string, unknown> = { type: "array" }
    recursive.items = recursive

    const invalidInputs: readonly [input: unknown, path: string][] = [
      [{ items: { type: "array" } }, "input.items.items"],
      [{ lookup: { type: "map", keySchema: "integer", valueSchema: "string" } }, "input.lookup"],
      [
        { filters: { type: "object", properties: { active: { required: true } } } },
        "input.filters.properties.active",
      ],
      [{ reference: { type: "valueTypeRef", valueTypeId: " " } }, "input.reference"],
      [{ mode: { type: "enum", valueType: "string", values: ["quick", "quick"] } }, "input.mode"],
      [{ recursive }, "input.recursive.items"],
    ]

    for (const [input, path] of invalidInputs) {
      expect(() => validateToolInput(input)).toThrow(`${path} must be a valid Sixb schema`)
    }
  })
})

describe("defineAgent", () => {
  test("builds an inert agent definition", () => {
    const agent = defineAgent("sales", {
      name: "Sales Assistant",
      model,
      instructions: "Assist.",
    })

    expect(agent.kind).toBe("agent")
    expect(agent.id).toBe("sales")
    expect(agent.name).toBe("Sales Assistant")
    expect(agent.instructions).toBe("Assist.")
    expect(agent.groupIds).toEqual([])
    expect(agent.tools).toEqual([])
    expect(agent.reasoning).toBeUndefined()
    expect(agent.providerOptions).toBeUndefined()
    expect(agent.description).toBeUndefined()
    expect(agent.loop).toBeUndefined()
  })

  test("keeps description, model options, groups, and loop when provided", () => {
    const searchKnowledge = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input({ query: "string" })
      .run(({ input }) => ({ query: input.query }))
    const agent = defineAgent("sales", {
      name: "Sales Assistant",
      description: "Quotes and contacts.",
      model,
      reasoning: "medium",
      providerOptions: {
        openai: {
          reasoningSummary: "detailed",
        },
      },
      instructions: "Assist.",
      groups: [agentRuntime],
      tools: [searchKnowledge],
      loop: { stopWhen: { maxSteps: 16 } },
    })

    expect(agent.description).toBe("Quotes and contacts.")
    expect(agent.reasoning).toBe("medium")
    expect(agent.providerOptions).toEqual({ openai: { reasoningSummary: "detailed" } })
    expect(agent.groupIds).toEqual(["agent-runtime"])
    expect(agent.tools).toEqual([searchKnowledge])
    expect(agent.tools[0]).toBe(searchKnowledge)
    expect(agent.loop).toEqual({ stopWhen: { maxSteps: 16 } })
  })

  test("rejects empty id, name, and instructions", () => {
    expect(() => defineAgent("", { name: "A", model, instructions: "x" })).toThrow(
      AgentDefinitionError
    )
    expect(() => defineAgent("a", { name: "  ", model, instructions: "x" })).toThrow(
      AgentDefinitionError
    )
    expect(() => defineAgent("a", { name: "A", model, instructions: " " })).toThrow(
      AgentDefinitionError
    )
  })

  test("rejects a missing model", () => {
    expect(() =>
      defineAgent("a", {
        name: "A",
        instructions: "x",
        model: undefined as unknown as LanguageModelV4,
      })
    ).toThrow(AgentDefinitionError)
  })

  test("rejects invalid maxSteps loop settings", () => {
    for (const maxSteps of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() =>
        defineAgent("bad", {
          name: "Bad",
          model,
          instructions: "x",
          loop: { stopWhen: { maxSteps } },
        })
      ).toThrow(AgentDefinitionError)
    }
  })

  test("rejects invalid reasoning settings", () => {
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        reasoning: "maximum" as never,
      })
    ).toThrow(AgentDefinitionError)
  })

  test("rejects invalid provider options", () => {
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        providerOptions: [] as never,
      })
    ).toThrow(AgentDefinitionError)
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        providerOptions: { openai: "fast" } as never,
      })
    ).toThrow(AgentDefinitionError)
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        providerOptions: { openai: { fn: () => undefined } } as never,
      })
    ).toThrow(AgentDefinitionError)
  })

  test("rejects invalid group definitions", () => {
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        groups: [{ kind: "not-a-group", id: "x" } as never],
      })
    ).toThrow(AgentDefinitionError)

    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        groups: [agentRuntime, agentRuntime],
      })
    ).toThrow(AgentDefinitionError)
  })

  test("rejects invalid and duplicate tool definitions", () => {
    const first = defineAgentTool("search")
      .description("Search one source.")
      .input({ query: "string" })
      .run(() => ({ results: [] }))
    const second = defineAgentTool("search")
      .description("Search another source.")
      .input({ query: "string" })
      .run(() => ({ results: [] }))

    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        tools: [first, second],
      })
    ).toThrow("duplicate tool name 'search'")
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        tools: [{ kind: "not-a-tool" } as never],
      })
    ).toThrow("only agent tool definitions")
  })
})

describe("isAgentDefinition", () => {
  test("accepts a real agent definition", () => {
    expect(isAgentDefinition(defineAgent("a", { name: "A", model, instructions: "x" }))).toBe(true)
  })

  test("rejects non-agents", () => {
    expect(isAgentDefinition(null)).toBe(false)
    expect(isAgentDefinition({ kind: "connector", id: "x" })).toBe(false)
    // Right kind but missing required string fields.
    expect(isAgentDefinition({ kind: "agent", id: "x" })).toBe(false)
  })
})

describe("agent discovery + registry", () => {
  test("returns no agents when agents/ is absent", async () => {
    const projectRoot = await createTempProjectRoot()
    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.agents.list()).toEqual([])
    expect(sixb.agents.getById("sales")).toBeNull()
  })

  test("discovers agents from agents/ (incl. subfolders) and looks them up by id", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/sales.ts", agentModule("sales", "Sales Assistant"))
    await writeProjectFile(
      projectRoot,
      "agents/nested/support.ts",
      agentModule("support", "Support")
    )

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(
      sixb.agents
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["sales", "support"])
    expect(sixb.agents.getById("sales")?.name).toBe("Sales Assistant")
    expect(sixb.agents.getById("unknown")).toBeNull()
  })

  test("discovers agents with selected tools without discovering tools themselves", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/research.ts", agentWithToolModule("research"))

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.agents.list().map((agent) => agent.id)).toEqual(["research"])
    expect(sixb.agents.getById("research")?.tools.map((tool) => tool.name)).toEqual([
      "search_knowledge",
    ])
  })

  test("ignores non-agent exports co-located in agents/", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/sales.ts", agentModule("sales"))
    await writeProjectFile(
      projectRoot,
      "agents/helpers.ts",
      `export const helper = { hello: "world" }\n`
    )

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.agents.list().map((a) => a.id)).toEqual(["sales"])
  })

  test("merges explicit agents with discovered ones", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/sales.ts", agentModule("sales"))
    const explicit = defineAgent("ops", { name: "Ops", model, instructions: "x" })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      agents: [explicit],
      ...createTestRuntimeDeps(),
    })

    expect(
      sixb.agents
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["ops", "sales"])
  })

  test("rejects duplicate agent ids", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/sales.ts", agentModule("sales"))
    const dup = defineAgent("sales", { name: "Dup", model, instructions: "x" })

    await expect(
      createSixb({ projectRoot, ontologies: [Room], agents: [dup], ...createTestRuntimeDeps() })
    ).rejects.toThrow(RuntimeError)
  })

  test("rejects agents that reference unregistered execution groups", async () => {
    const projectRoot = await createTempProjectRoot()
    const agent = defineAgent("ops", {
      name: "Ops",
      model,
      instructions: "x",
      groups: [agentRuntime],
    })

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        agents: [agent],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow(AgentDefinitionError)
  })

  test("accepts agents whose execution groups are registered", async () => {
    const projectRoot = await createTempProjectRoot()
    const agent = defineAgent("ops", {
      name: "Ops",
      model,
      instructions: "x",
      groups: [agentRuntime],
    })

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      agents: [agent],
      groups: [agentRuntime],
      ...createTestRuntimeDeps(),
    })

    expect(sixb.agents.getById("ops")?.groupIds).toEqual(["agent-runtime"])
  })
})
