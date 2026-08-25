import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { LanguageModelV4 } from "@ai-sdk/provider"
import {
  type AgentDefinition,
  AgentDefinitionError,
  type AgentToolDefinition,
  can,
  createSixb,
  defineAgent,
  defineAgentTool,
  defineGroup,
  defineObjectType,
  defineRole,
  every,
  isAgentDefinition,
  prop,
  RuntimeError,
} from "../src"
import { AgentToolResultValidationError } from "../src/agents/errors"
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
  test("builds an immutable definition with snapshotted input and output", async () => {
    const inputSchema = { query: "string", limit: "integer" } as const
    const handlerResult = { results: ["sixb"], limit: 3 }
    const searchKnowledge = defineAgentTool("search_knowledge")
      .description("Search project knowledge.")
      .input(inputSchema)
      .run(() => handlerResult)

    ;(inputSchema as { query: string }).query = "boolean"

    expect(searchKnowledge.kind).toBe("agentTool")
    expect(searchKnowledge.name).toBe("search_knowledge")
    expect(searchKnowledge.description).toBe("Search project knowledge.")
    expect(searchKnowledge.input).toEqual({ query: "string", limit: "integer" })
    expect(Object.isFrozen(searchKnowledge)).toBe(true)
    expect(Object.isFrozen(searchKnowledge.input)).toBe(true)

    const result = await searchKnowledge.handler({
      input: { query: "sixb", limit: 3 },
    } as never)
    expect(result).toEqual({ results: ["sixb"], limit: 3 })
    expect(result).not.toBe(handlerResult)
    handlerResult.results.push("mutated")
    expect(result).toEqual({ results: ["sixb"], limit: 3 })

    const invalidResult = defineAgentTool("invalid_result")
      .description("Return an invalid result.")
      .input({})
      .run((() => ({ value: undefined })) as never)

    const invalidResultPromise = invalidResult.handler({ input: {} } as never)
    await expect(invalidResultPromise).rejects.toBeInstanceOf(AgentToolResultValidationError)
    await expect(invalidResultPromise).rejects.toMatchObject({
      toolName: "invalid_result",
      reason: "result.value is undefined",
    })
  })

  test("deeply snapshots and freezes nested input schemas", () => {
    const values = ["quick", "deep"]
    const input = {
      mode: { type: "enum" as const, valueType: "string" as const, values },
    }
    const tool = defineAgentTool("search_mode")
      .description("Select a search mode.")
      .input(input)
      .run(() => null)

    values.push("mutated")

    expect(tool.input.mode.values).toEqual(["quick", "deep"])
    expect(Object.isFrozen(tool.input.mode)).toBe(true)
    expect(Object.isFrozen(tool.input.mode.values)).toBe(true)
  })

  test("rejects invalid and reserved names", () => {
    const validateName = (name: string): void => {
      defineAgentTool(name)
    }
    for (const name of ["", "1search", "search knowledge", "a".repeat(65)]) {
      expect(() => validateName(name)).toThrow(AgentDefinitionError)
    }
    expect(() => validateName("bash")).toThrow("reserved by the framework")
    expect(() => validateName("sub_agent")).toThrow("reserved by the framework")
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

    const mutableInput = { query: "string" }
    const runBuilder = defineAgentTool("mutable_input")
      .description("Catch mutations between builder stages.")
      .input(mutableInput as { query: "string" })
    mutableInput.query = "unknown"
    expect(() => runBuilder.run(() => null)).toThrow("input.query must be a valid Sixb schema")
  })

  test("rejects malformed nested input schemas", () => {
    const recursive: Record<string, unknown> = { type: "array" }
    recursive.items = recursive
    const sparseEnumValues = new Array<string>(1)

    const invalidInputs: readonly [input: unknown, path: string][] = [
      [{ items: { type: "array" } }, "input.items.items"],
      [{ lookup: { type: "map", keySchema: "integer", valueSchema: "string" } }, "input.lookup"],
      [
        { filters: { type: "object", properties: { active: { required: true } } } },
        "input.filters.properties.active",
      ],
      [{ reference: { type: "valueTypeRef", valueTypeId: " " } }, "input.reference"],
      [{ mode: { type: "enum", valueType: "string", values: ["quick", "quick"] } }, "input.mode"],
      [{ mode: { type: "enum", valueType: "string", values: sparseEnumValues } }, "input.mode"],
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
    expect(Object.isFrozen(agent)).toBe(true)
    expect(Object.isFrozen(agent.groupIds)).toBe(true)
    expect(Object.isFrozen(agent.tools)).toBe(true)
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
    expect(() => {
      ;(searchKnowledge as unknown as { name: string }).name = "bash"
    }).toThrow(TypeError)
  })

  test("normalizes manually constructed tools before selecting them", async () => {
    const input = { query: "string" } as { query: string }
    const handlerResult = { results: ["sixb"] }
    const manualTool = {
      kind: "agentTool" as const,
      name: "manual_search",
      description: "Search manually.",
      input,
      handler: () => handlerResult,
    } as AgentToolDefinition

    const agent = defineAgent("manual", {
      name: "Manual",
      model,
      instructions: "Use the selected tool.",
      tools: [manualTool],
    })
    input.query = "boolean"

    const selectedTool = agent.tools[0]
    expect(selectedTool).not.toBe(manualTool)
    expect(selectedTool?.input).toEqual({ query: "string" })
    expect(Object.isFrozen(selectedTool)).toBe(true)
    expect(Object.isFrozen(selectedTool?.input)).toBe(true)

    const result = await selectedTool?.handler({ input: { query: "sixb" } } as never)
    expect(result).toEqual({ results: ["sixb"] })
    expect(result).not.toBe(handlerResult)
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

    const sparseTools = new Array<AgentToolDefinition>(1)
    expect(() =>
      defineAgent("bad", {
        name: "Bad",
        model,
        instructions: "x",
        tools: sparseTools,
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

  test("rejects definitions whose tools array is sparse", () => {
    const agent = defineAgent("a", { name: "A", model, instructions: "x" })
    expect(isAgentDefinition({ ...agent, tools: new Array<AgentToolDefinition>(1) })).toBe(false)
  })
})

describe("agent discovery + registry", () => {
  test("returns no agents when agents/ is absent", async () => {
    const projectRoot = await createTempProjectRoot()
    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.definitions.agents.list()).toEqual([])
    expect(sixb.definitions.agents.getById("sales")).toBeNull()
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
      sixb.definitions.agents
        .list()
        .map((a) => a.id)
        .sort()
    ).toEqual(["sales", "support"])
    expect(sixb.definitions.agents.getById("sales")?.name).toBe("Sales Assistant")
    expect(sixb.definitions.agents.getById("unknown")).toBeNull()
  })

  test("discovers agents with selected tools without discovering tools themselves", async () => {
    const projectRoot = await createTempProjectRoot()
    await writeProjectFile(projectRoot, "agents/research.ts", agentWithToolModule("research"))

    const sixb = await createSixb({ projectRoot, ontologies: [Room], ...createTestRuntimeDeps() })

    expect(sixb.definitions.agents.list().map((agent) => agent.id)).toEqual(["research"])
    expect(sixb.definitions.agents.getById("research")?.tools.map((tool) => tool.name)).toEqual([
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

    expect(sixb.definitions.agents.list().map((a) => a.id)).toEqual(["sales"])
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
      sixb.definitions.agents
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

  test("revalidates directly constructed tool definitions at startup", async () => {
    const projectRoot = await createTempProjectRoot()
    const manualTool = {
      kind: "agentTool" as const,
      name: "manual_search",
      description: "Search manually.",
      input: { query: "string" },
      handler: () => null,
    }
    const manualAgent = {
      kind: "agent" as const,
      id: "manual",
      name: "Manual",
      model,
      instructions: "Use the selected tool.",
      groupIds: [],
      tools: [manualTool],
    } as AgentDefinition

    manualTool.name = "bash"
    expect(isAgentDefinition(manualAgent)).toBe(true)
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        agents: [manualAgent],
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("reserved by the framework")
  })

  test("locks directly constructed tool definitions at startup", async () => {
    const projectRoot = await createTempProjectRoot()
    const input = { query: "string" }
    const manualTool = {
      kind: "agentTool" as const,
      name: "manual_search",
      description: "Search manually.",
      input,
      handler: () => null,
    }
    const manualAgent = {
      kind: "agent" as const,
      id: "manual",
      name: "Manual",
      model,
      instructions: "Use the selected tool.",
      groupIds: [],
      tools: [manualTool],
    } as AgentDefinition

    await createSixb({
      projectRoot,
      ontologies: [Room],
      agents: [manualAgent],
      ...createTestRuntimeDeps(),
    })

    expect(Object.isFrozen(manualAgent)).toBe(true)
    expect(Object.isFrozen(manualAgent.tools)).toBe(true)
    expect(Object.isFrozen(manualTool)).toBe(true)
    expect(Object.isFrozen(input)).toBe(true)
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

    expect(sixb.definitions.agents.getById("ops")?.groupIds).toEqual(["agent-runtime"])
  })
})

describe("createSixb({ mainAgent })", () => {
  test("registers the framework main agent with no groups and no authored tools", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      mainAgent: { name: "Assistant", model, instructions: "Delegate specialist work." },
      ...createTestRuntimeDeps(),
    })

    const main = sixb.definitions.agents.getById("main")
    expect(main?.name).toBe("Assistant")
    // No groups is the design, not an oversight: the main agent routes and holds no grants of its
    // own, so `sub_agent` authorizes against the requester instead.
    expect(main?.groupIds).toEqual([])
    expect(main?.tools).toEqual([])
  })

  test("names the reserved id when a project agent collides with it", async () => {
    const projectRoot = await createTempProjectRoot()

    // Asserting the *message*, not just that it throws: without the explicit guard this still
    // fails, but as `Duplicate agent id: main`, which sends the author hunting for a second
    // definition that does not exist.
    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        agents: [defineAgent("main", { name: "Mine", model, instructions: "x" })],
        mainAgent: { name: "Assistant", model, instructions: "y" },
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow("is reserved for the framework-managed main agent")
  })

  test("validates the main agent through defineAgent rather than a second code path", async () => {
    const projectRoot = await createTempProjectRoot()

    await expect(
      createSixb({
        projectRoot,
        ontologies: [Room],
        mainAgent: { name: "   ", model, instructions: "x" },
        ...createTestRuntimeDeps(),
      })
    ).rejects.toThrow(AgentDefinitionError)
  })

  test("reaches the security registry, so breadth grants resolve against it", async () => {
    const projectRoot = await createTempProjectRoot()

    const sixb = await createSixb({
      projectRoot,
      ontologies: [Room],
      agents: [defineAgent("researcher", { name: "Researcher", model, instructions: "x" })],
      mainAgent: { name: "Assistant", model, instructions: "Delegate." },
      groups: [agentRuntime],
      roles: [
        defineRole("agent-runtime.runner", {
          grantedTo: [agentRuntime],
          grants: [can.run(every.agent())],
        }),
      ],
      ...createTestRuntimeDeps(),
    })

    // Appending `main` only to the returned catalog would leave it out of `SecurityRegistry`, and
    // this breadth grant would silently resolve to `["researcher"]` — nobody could run the agent
    // the project just configured.
    const resolved = sixb.definitions.security.listResolvedRoles()
    expect([...(resolved[0]?.grants["run:agent"] ?? [])].sort()).toEqual(["main", "researcher"])
  })
})
