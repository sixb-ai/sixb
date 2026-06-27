import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  AgentDefinitionError,
  createSixb,
  defineAgent,
  defineGroup,
  defineObjectType,
  isAgentDefinition,
  prop,
  RuntimeError,
} from "../src"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const coreModuleUrl = pathToFileURL(resolve(import.meta.dir, "..", "src", "index.ts")).href
const tempRoots = new Set<string>()

// PR1 never reads the model, so a stub conforming to the type is enough.
const model = {} as LanguageModelV3
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
  model: { specificationVersion: "v3", provider: "test", modelId: "test" },
  instructions: "You assist the user.",
})
`
}

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
    expect(agent.description).toBeUndefined()
    expect(agent.loop).toBeUndefined()
  })

  test("keeps description, groups, and loop when provided", () => {
    const agent = defineAgent("sales", {
      name: "Sales Assistant",
      description: "Quotes and contacts.",
      model,
      instructions: "Assist.",
      groups: [agentRuntime],
      loop: { stopWhen: { maxSteps: 16 } },
    })

    expect(agent.description).toBe("Quotes and contacts.")
    expect(agent.groupIds).toEqual(["agent-runtime"])
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
        model: undefined as unknown as LanguageModelV3,
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
